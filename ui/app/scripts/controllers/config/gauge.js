/*
 * Copyright 2012-2016 the original author or authors.
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

/* global glowroot, angular */

glowroot.controller('ConfigGaugeCtrl', [
  '$scope',
  '$location',
  '$http',
  '$timeout',
  'confirmIfHasChanges',
  'httpErrors',
  'queryStrings',
  function ($scope, $location, $http, $timeout, confirmIfHasChanges, httpErrors, queryStrings) {

    var version = $location.search().v;

    function onNewData(data) {
      // need to sort attribute names to keep hasChanges() consistent
      if (data.config.mbeanAttributes) {
        data.config.mbeanAttributes.sort(function (a, b) {
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
      }
      $scope.config = data.config;
      $scope.originalConfig = angular.copy(data.config);

      if (data.config.mbeanObjectName) {
        $scope.heading = data.config.display;
        // \u200b is zero width space and \u00a0 is non-breaking space
        // these are used to change wrapping behavior on smaller screens (or larger mbean names)
        $scope.heading = $scope.heading.replace(/\//g, '\u200b/');
        $scope.heading = $scope.heading.replace(/ /g, '\u00a0');
        $scope.selectedMBeanObjectName = data.config.mbeanObjectName;
        $scope.mbeanUnavailable = data.mbeanUnavailable;
        $scope.mbeanUnmatched = data.mbeanUnmatched;
        var allMBeanAttributes = {};
        angular.forEach(data.mbeanAvailableAttributeNames, function (mbeanAttributeName) {
          allMBeanAttributes[mbeanAttributeName] = {
            checked: false,
            counter: false,
            available: true
          };
        });
        angular.forEach(data.config.mbeanAttributes, function (mbeanAttr) {
          var mbeanAttribute = allMBeanAttributes[mbeanAttr.name];
          if (mbeanAttribute) {
            mbeanAttribute.checked = true;
            mbeanAttribute.counter = mbeanAttr.counter;
          } else {
            allMBeanAttributes[mbeanAttr.name] = {
              checked: true,
              counter: mbeanAttr.counter,
              available: false
            };
          }
        });
        // need to put attributes in an array to loop in ng-repeat with orderBy
        $scope.allMBeanAttributes = [];
        angular.forEach(allMBeanAttributes, function (value, key) {
          $scope.allMBeanAttributes.push({
            name: key,
            checked: value.checked,
            counter: value.counter,
            available: value.available
          });
        });
      } else {
        $scope.heading = '<New>';
      }
    }

    if (version) {
      $http.get('backend/config/gauges?server-id=' + $scope.serverId + '&version=' + version)
          .success(function (data) {
            $scope.loaded = true;
            onNewData(data);
          })
          .error(httpErrors.handler($scope));
    } else {
      $scope.loaded = true;
      onNewData({
        config: {
          mbeanAttributes: []
        },
        mbeanAvailable: false,
        mbeanAvailableAttributeNames: []
      });
    }

    $scope.$watch('allMBeanAttributes', function (newValue, oldValue) {
      if (newValue !== oldValue) {
        $scope.config.mbeanAttributes = [];
        angular.forEach($scope.allMBeanAttributes, function (mbeanAttribute) {
          if (mbeanAttribute.checked) {
            $scope.config.mbeanAttributes.push({
              name: mbeanAttribute.name,
              counter: mbeanAttribute.counter
            });
          }
        });
        // need to sort attribute names to keep hasChanges() consistent
        $scope.config.mbeanAttributes.sort(function (a, b) {
          return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
      }
    }, true);

    $scope.hasChanges = function () {
      return !angular.equals($scope.config, $scope.originalConfig);
    };
    var removeConfirmIfHasChangesListener = $scope.$on('$locationChangeStart', confirmIfHasChanges($scope));

    $scope.showMBeanObjectNameSpinner = 0;

    $scope.mbeanObjectNames = function (suggestion) {
      if (suggestion.indexOf('*') !== -1) {
        return [suggestion];
      }
      var queryData = {
        serverId: $scope.serverId,
        partialMBeanObjectName: suggestion,
        limit: 10
      };
      $scope.showMBeanObjectNameSpinner++;
      // use 'then' method to return promise
      return $http.get('backend/config/matching-mbean-objects' + queryStrings.encodeObject(queryData))
          .then(function (response) {
            $scope.showMBeanObjectNameSpinner--;
            return response.data;
          }, function (data, status) {
            $scope.showMBeanObjectNameSpinner--;
            httpErrors.handler($scope)(data, status);
          });
    };

    $scope.onSelectMBeanObjectName = function () {
      var mbeanObjectName = $scope.config.mbeanObjectName;
      // check if the value has really changed (e.g. that a user didn't start altering text and
      // then changed mind and put the previous value back)
      if (mbeanObjectName !== $scope.selectedMBeanObjectName) {
        $scope.selectedMBeanObjectName = mbeanObjectName;
        fetchMBeanAttributes(mbeanObjectName);
      }
    };

    $scope.onBlurMBeanObjectName = function () {
      if (!$scope.config.mbeanObjectName) {
        // the user cleared the text input and tabbed away
        $scope.mbeanUnavailable = false;
        $scope.mbeanUnmatched = false;
        $scope.duplicateMBean = false;
        $scope.allMBeanAttributes = [];
      }
    };

    function fetchMBeanAttributes(mbeanObjectName) {
      var queryData = {
        serverId: $scope.serverId,
        mbeanObjectName: mbeanObjectName,
        gaugeVersion: $scope.config.version || ''
      };
      $scope.mbeanAttributesLoading = true;
      $http.get('backend/config/mbean-attributes' + queryStrings.encodeObject(queryData))
          .success(function (data) {
            $scope.mbeanAttributesLoading = false;
            $scope.mbeanUnavailable = data.mbeanUnavailable;
            $scope.mbeanUnmatched = data.mbeanUnmatched;
            $scope.duplicateMBean = data.duplicateMBean;
            $scope.allMBeanAttributes = [];
            angular.forEach(data.mbeanAttributes, function (mbeanAttribute) {
              $scope.allMBeanAttributes.push({
                name: mbeanAttribute,
                checked: false,
                counter: false,
                available: true
              });
            });
          })
          .error(function (data, status) {
            $scope.mbeanAttributesLoading = false;
            httpErrors.handler($scope)(data, status);
          });
    }

    $scope.hasMBeanObjectNameError = function () {
      return $scope.config && (!$scope.config.mbeanObjectName || $scope.mbeanUnavailable
          || $scope.mbeanUnmatched || $scope.duplicateMBean);
    };

    $scope.saveDisabled = function () {
      return !$scope.hasChanges() || !$scope.config.mbeanAttributes.length || $scope.formCtrl.$invalid
          || $scope.mbeanUnavailable || $scope.mbeanUnmatched || $scope.duplicateMBean;
    };

    $scope.save = function (deferred) {
      var postData = angular.copy($scope.config);
      postData.serverId = $scope.serverId;
      postData.mbeanAttributes = $scope.config.mbeanAttributes;
      var url;
      if (version) {
        url = 'backend/config/gauges/update';
      } else {
        url = 'backend/config/gauges/add';
      }
      $http.post(url, postData)
          .success(function (data) {
            onNewData(data);
            deferred.resolve(version ? 'Saved' : 'Added');
            version = data.config.version;
            // fix current url (with updated version) before returning to list page in case back button is used later
            $timeout(function () {
              $location.search({v: version}).replace();
              $timeout(function () {
                $location.url('config/gauge-list');
              });
            });
          })
          .error(function (data, status) {
            if (status === 409 && data.message === 'mbeanObjectName') {
              $scope.duplicateMBean = true;
              deferred.reject('There is already a gauge for this MBean');
              return;
            }
            httpErrors.handler($scope, deferred)(data, status);
          });
    };

    $scope.delete = function (deferred) {
      var postData = {
        serverId: $scope.serverId,
        version: $scope.config.version
      };
      $http.post('backend/config/gauges/remove', postData)
          .success(function () {
            removeConfirmIfHasChangesListener();
            $location.url('config/gauge-list').replace();
          })
          .error(httpErrors.handler($scope, deferred));
    };
  }
]);