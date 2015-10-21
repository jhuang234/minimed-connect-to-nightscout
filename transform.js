/* jshint node: true */
"use strict";

var extend = require('extend');

var logger = require('./logger');

var STALE_DATA_THRESHOLD_MINUTES = 20;
var PUMP_STATUS_ENTRY_TYPE = 'pump_status';
var SENSOR_GLUCOSE_ENTRY_TYPE = 'sgv';
var CARELINK_TREND_TO_NIGHTSCOUT_TREND = {
  'NONE': {'trend': 0, 'direction': 'NONE'},
  'UP_DOUBLE': {'trend': 1, 'direction': 'DoubleUp'},
  'UP': {'trend': 2, 'direction': 'SingleUp'},
  'DOWN': {'trend': 6, 'direction': 'SingleDown'},
  'DOWN_DOUBLE': {'trend': 7, 'direction': 'DoubleDown'}
};

function parsePumpTime(pumpTimeString, offset) {
  return Date.parse(pumpTimeString + ' ' + offset);
}

function addTimeToEntry(timestamp, entry) {
  entry['date'] = timestamp;
  entry['dateString'] = new Date(timestamp).toISOString();
  return entry;
}

var guessPumpOffset = (function() {
  var lastGuess;

  // From my observations, sMedicalDeviceTime is advanced by the server even when the app is
  // not reporting data or the pump is not connected, so its difference from server time is
  // always close to a whole number of hours, and can be used to guess the pump's timezone:
  // https://gist.github.com/mddub/f673570e6427c93784bf
  return function(data) {
    var pumpTimeAsIfUTC = Date.parse(data['sMedicalDeviceTime'] + ' +0');
    var serverTimeUTC = data['currentServerTime'];
    var hours = Math.round((pumpTimeAsIfUTC - serverTimeUTC) / (60*60*1000));
    var offset = (hours >= 0 ? '+' : '-') + (Math.abs(hours) < 10 ? '0' : '') + Math.abs(hours) + '00';
    if (offset !== lastGuess) {
      logger.log('Guessed pump timezone ' + offset + ' (pump time: "' + data['sMedicalDeviceTime'] + '"; server time: ' + new Date(data['currentServerTime']) + ')');
    }
    lastGuess = offset;
    return offset;
  };
})();

function pumpStatusEntry(data) {
  var entry = {'type': PUMP_STATUS_ENTRY_TYPE};

  // For the values these can take, see:
  // https://gist.github.com/mddub/5e4a585508c93249eb51
  [
    // booleans
    'conduitInRange',
    'conduitMedicalDeviceInRange',
    'conduitSensorInRange',
    'medicalDeviceSuspended',
    // numbers
    'conduitBatteryLevel',
    'reservoirLevelPercent',
    'reservoirAmount',
    'medicalDeviceBatteryLevelPercent',
    'sensorDurationHours',
    'timeToNextCalibHours',
    // strings
    'sensorState',
    'calibStatus'
  ].forEach(function(key) {
    if(data[key] !== undefined) {
      entry[key] = data[key];
    }
  });

  if(data['activeInsulin'] && data['activeInsulin']['amount'] >= 0) {
    entry['iob'] = data['activeInsulin']['amount'];
  }

  return addTimeToEntry(data['lastMedicalDeviceDataUpdateServerTime'], entry);
}

function sgvEntries(data) {
  var offset = guessPumpOffset(data);

  if (!data['sgs'] || !data['sgs'].length) {
    return [];
  }

  var sgvs = data['sgs'].filter(function(entry) {
    return entry['kind'] === 'SG' && entry['sg'] !== 0;
  }).map(function(sgv) {
    return addTimeToEntry(
      parsePumpTime(sgv['datetime'], offset),
      {
        'type': SENSOR_GLUCOSE_ENTRY_TYPE,
        'sgv': sgv['sg'],
      }
    );
  });

  if(data['sgs'][data['sgs'].length - 1]['sg'] !== 0) {
    sgvs[sgvs.length - 1] = extend(
      true,
      sgvs[sgvs.length - 1],
      CARELINK_TREND_TO_NIGHTSCOUT_TREND[data['lastSGTrend']]
    );
  }

  return sgvs;
}

var transform = module.exports = function(data, sgvLimit) {
  var recency = (data['currentServerTime'] - data['lastMedicalDeviceDataUpdateServerTime']) / (60 * 1000);
  if (recency > STALE_DATA_THRESHOLD_MINUTES) {
    logger.log('Stale CareLink data: ' + recency.toFixed(2) + ' minutes old');
    return [];
  }

  if (sgvLimit === undefined) {
    sgvLimit = Infinity;
  }

  var entries = [];

  entries.push(pumpStatusEntry(data));

  var sgvs = sgvEntries(data);
  // TODO: this assumes sgvs are ordered by date ascending
  for(var i = Math.max(0, sgvs.length - sgvLimit); i < sgvs.length; i++) {
    entries.push(sgvs[i]);
  }

  entries.forEach(function(entry) {
    entry['device'] = 'connect://' + data['medicalDeviceFamily'].toLowerCase();
  });

  return entries;
};
