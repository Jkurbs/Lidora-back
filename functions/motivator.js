
'use strict';

const admin = require('firebase-admin');
const functions = require('firebase-functions');
admin.initializeApp();

// TODO: Make sure you configure the 'dev_motivator.device_token' Google Cloud environment variables.
const deviceToken = functions.config().dev_motivator.device_token;

/**
 * Triggers when the app is opened the first time in a user device and sends a notification to your developer device.
 *
 * The device model name, the city and the country of the user are sent in the notification message
 */
exports.appinstalled = functions.analytics.event('first_open').onLog((event) => {
  const user = event.user;
  const payload = {
    notification: {
      title: 'You have a new user \uD83D\uDE43',
      body: `${user.deviceInfo.mobileModelName} from ${user.geoInfo.city}, ${user.geoInfo.country}`,
    }
  };

  return admin.messaging().sendToDevice(deviceToken, payload);
});

/**
 * Triggers when the app is removed from the user device and sends a notification to your developer device.
 * NOTE: for this trigger to  work, you must mark the `app_remove` event as a conversion event in Firebase's
 * Analytics dashboard.
 *
 * The device model name, the city and the country of the user are sent in the notification message
 */
exports.appremoved = functions.analytics.event('app_remove').onLog((event) => {
  const user = event.user;
  const payload = {
    notification: {
      title: 'You lost a user \uD83D\uDE1E',
      body: `${user.deviceInfo.mobileModelName} from ${user.geoInfo.city}, ${user.geoInfo.country}`,
    }
  };

  return admin.messaging().sendToDevice(deviceToken, payload);
});


