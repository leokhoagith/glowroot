/*
 * Copyright 2015-2016 the original author or authors.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package org.glowroot.agent.plugin.httpclient;

import java.util.concurrent.Executor;
import java.util.concurrent.Future;

import javax.annotation.Nullable;

import org.glowroot.agent.plugin.api.Agent;
import org.glowroot.agent.plugin.api.config.ConfigService;
import org.glowroot.agent.plugin.api.transaction.AsyncService;
import org.glowroot.agent.plugin.api.transaction.AsyncTraceEntry;
import org.glowroot.agent.plugin.api.transaction.Message;
import org.glowroot.agent.plugin.api.transaction.MessageSupplier;
import org.glowroot.agent.plugin.api.transaction.Timer;
import org.glowroot.agent.plugin.api.transaction.TimerName;
import org.glowroot.agent.plugin.api.transaction.TransactionService;
import org.glowroot.agent.plugin.api.util.FastThreadLocal;
import org.glowroot.agent.plugin.api.weaving.BindClassMeta;
import org.glowroot.agent.plugin.api.weaving.BindParameter;
import org.glowroot.agent.plugin.api.weaving.BindReceiver;
import org.glowroot.agent.plugin.api.weaving.BindReturn;
import org.glowroot.agent.plugin.api.weaving.BindThrowable;
import org.glowroot.agent.plugin.api.weaving.BindTraveler;
import org.glowroot.agent.plugin.api.weaving.IsEnabled;
import org.glowroot.agent.plugin.api.weaving.Mixin;
import org.glowroot.agent.plugin.api.weaving.OnAfter;
import org.glowroot.agent.plugin.api.weaving.OnBefore;
import org.glowroot.agent.plugin.api.weaving.OnReturn;
import org.glowroot.agent.plugin.api.weaving.OnThrow;
import org.glowroot.agent.plugin.api.weaving.Pointcut;
import org.glowroot.agent.plugin.api.weaving.Shim;

public class AsyncHttpClientAspect {

    private static final TransactionService transactionService = Agent.getTransactionService();
    private static final AsyncService asyncService = Agent.getAsyncService();
    private static final ConfigService configService = Agent.getConfigService("http-client");

    @SuppressWarnings("nullness:type.argument.type.incompatible")
    private static final FastThreadLocal<Boolean> ignoreFutureGet = new FastThreadLocal<Boolean>() {
        @Override
        protected Boolean initialValue() {
            return false;
        }
    };

    // the field and method names are verbose to avoid conflict since they will become fields
    // and methods in all classes that extend com.ning.http.client.ListenableFuture
    @Mixin("com.ning.http.client.ListenableFuture")
    public abstract static class ListenableFutureImpl implements ListenableFutureMixin {

        // volatile not needed, only accessed by the main thread
        private @Nullable AsyncTraceEntry glowroot$asyncTraceEntry;

        @Override
        public @Nullable AsyncTraceEntry glowroot$getAsyncTraceEntry() {
            return glowroot$asyncTraceEntry;
        }

        @Override
        public void glowroot$setAsyncTraceEntry(@Nullable AsyncTraceEntry asyncTraceEntry) {
            this.glowroot$asyncTraceEntry = asyncTraceEntry;
        }
    }

    // the method names are verbose to avoid conflict since they will become methods in all classes
    // that extend com.ning.http.client.ListenableFuture
    public interface ListenableFutureMixin {

        @Nullable
        AsyncTraceEntry glowroot$getAsyncTraceEntry();

        void glowroot$setAsyncTraceEntry(@Nullable AsyncTraceEntry asyncTraceEntry);
    }

    @Shim("com.ning.http.client.ListenableFuture")
    public interface ListenableFutureShim<V> extends Future<V> {

        @Shim("com.ning.http.client.ListenableFuture"
                + " addListener(java.lang.Runnable, java.util.concurrent.Executor)")
        ListenableFutureShim<V> addListener(Runnable listener, Executor exec);
    }

    @Pointcut(className = "com.ning.http.client.AsyncHttpClient", methodName = "executeRequest",
            methodParameterTypes = {"com.ning.http.client.Request", ".."},
            timerName = "http client request")
    public static class ExecuteRequestAdvice {
        private static final TimerName timerName =
                transactionService.getTimerName(ExecuteRequestAdvice.class);
        @IsEnabled
        public static boolean isEnabled() {
            return configService.isEnabled();
        }
        @OnBefore
        public static AsyncTraceEntry onBefore(@BindParameter Object request,
                @BindClassMeta RequestInvoker requestInvoker) {
            // need to start trace entry @OnBefore in case it is executed in a "same thread
            // executor" in which case will be over in @OnReturn
            String method = requestInvoker.getMethod(request);
            String url = requestInvoker.getUrl(request);
            return asyncService.startAsyncTraceEntry(new RequestMessageSupplier(method, url),
                    timerName, timerName);
        }
        @OnReturn
        public static void onReturn(@BindReturn @Nullable ListenableFutureMixin future,
                final @BindTraveler AsyncTraceEntry asyncTraceEntry) {
            asyncTraceEntry.stopSyncTimer();
            if (future == null) {
                asyncTraceEntry.end();
                return;
            }
            future.glowroot$setAsyncTraceEntry(asyncTraceEntry);
            final ListenableFutureShim<?> listenableFuture = (ListenableFutureShim<?>) future;
            listenableFuture.addListener(new Runnable() {
                @Override
                public void run() {
                    Throwable t = getException(listenableFuture);
                    if (t == null) {
                        asyncTraceEntry.end();
                    } else {
                        asyncTraceEntry.endWithError(t);
                    }
                }
            }, DirectExecutor.INSTANCE);
        }
        @OnThrow
        public static void onThrow(@BindThrowable Throwable throwable,
                @BindTraveler AsyncTraceEntry asyncTraceEntry) {
            asyncTraceEntry.stopSyncTimer();
            asyncTraceEntry.endWithError(throwable);
        }
    }

    @Pointcut(className = "com.ning.http.client.ListenableFuture",
            methodDeclaringClassName = "java.util.concurrent.Future", methodName = "get",
            methodParameterTypes = {".."})
    public static class FutureGetAdvice {
        @OnBefore
        public static @Nullable Timer onBefore(@BindReceiver ListenableFutureMixin future) {
            AsyncTraceEntry asyncTraceEntry = future.glowroot$getAsyncTraceEntry();
            if (asyncTraceEntry == null) {
                return null;
            }
            return asyncTraceEntry.extendSyncTimer();
        }
        @OnAfter
        public static void onAfter(@BindTraveler @Nullable Timer syncTimer) {
            if (syncTimer != null) {
                syncTimer.stop();
            }
        }
    }

    // this is hacky way to find out if future ended with exception or not
    private static @Nullable Throwable getException(ListenableFutureShim<?> future) {
        ignoreFutureGet.set(true);
        try {
            future.get();
        } catch (Throwable t) {
            return t;
        } finally {
            ignoreFutureGet.set(true);
        }
        return null;
    }

    private static class RequestMessageSupplier extends MessageSupplier {

        private final String method;
        private final String url;

        private RequestMessageSupplier(String method, String url) {
            this.method = method;
            this.url = url;
        }

        @Override
        public Message get() {
            return Message.from("http client request: {} {}", method, url);
        }
    }

    private static class DirectExecutor implements Executor {

        private static DirectExecutor INSTANCE = new DirectExecutor();

        @Override
        public void execute(Runnable command) {
            command.run();
        }
    }
}