'use strict';
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { Logging } = require('@google-cloud/logging');
const deviceToken =  functions.config().dev_motivator.device_token

const logging = new Logging({
  projectId: process.env.GCLOUD_PROJECT,
});

const stripe = require('stripe')(functions.config().stripe.secret, {
  apiVersion: '2020-03-02',
});

admin.initializeApp();


/** STRIPE */

// Keeps track of the length of the 'likes' child list in a separate property.
// TODO: Remeber to get ADDRESS and DOB from backend.


exports.createConnectedAccount = functions.firestore.document('/chefs/{userId}').onCreate(async (snap, context) => {

  const userId = snap.id; 
  const { first_name, last_name, email_address, phone } = snap.data();

  try {
    const account = await stripe.accounts.create({
      type: 'custom',
      country: 'US',
      email: email_address,
      business_type: "individual",
      individual: {
        email: email_address,
        first_name: first_name, 
        last_name: last_name,
        phone: phone, 
        address: {
          city: "North Miami Beach",
          country: "US",
          line1: "14212 Northeast 3rd Avenue",
          line2: null,
          postal_code: "33161",
          state: "FL"
        },
        dob: {
          day: 18,
          month: 11,
          year: 1996
        },
      }, 
      capabilities: {
        card_payments: {requested: true},
        transfers: {requested: true},
      },
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: "73.125.224.214",
      },
    });

    const bankAccount = await stripe.accounts.createExternalAccount(
      account.id,
      {
        external_account: 'btok_1HMxViLjpR7kl7iGMwPfsDaR',
      }
    );
    return;
   } catch (error) { 
    await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
    await reportError(error, { user: context.params.userId });
   }
});


exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
  const customer = await stripe.customers.create({ email: user.email });
  const intent = await stripe.setupIntents.create({
    customer: customer.id,
  });
  await admin.firestore().collection('customers').doc(user.uid).set({
    customer_id: customer.id,
    setup_secret: intent.client_secret,
  });
  return;
});


/**
 * When adding the payment method ID on the client,
 * this function is triggered to retrieve the payment method details.
 */
exports.addPaymentMethodDetails = functions.firestore
  .document('/customers/{userId}/payment_methods/{pushId}')
  .onCreate(async (snap, context) => {
    try {
      const paymentMethodId = snap.data().id;
      const paymentMethod = await stripe.paymentMethods.retrieve(
        paymentMethodId
      );
      await snap.ref.set(paymentMethod);
      // Create a new SetupIntent so the customer can add a new method next time.
      const intent = await stripe.setupIntents.create({
        customer: paymentMethod.customer,
      });
      await snap.ref.parent.parent.set(
        {
          setup_secret: intent.client_secret,
        },
        { merge: true }
      );
      return;
    } catch (error) {
      await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
      await reportError(error, { user: context.params.userId });
    }
  });




  // [START chargecustomer]

exports.createStripePayment = functions.firestore
.document('customers/{userId}/payments/{pushId}')
.onCreate(async (snap, context) => {
  const { amount, currency, payment_method } = snap.data();
  try {
    // Look up the Stripe customer id.
    const customer = (await snap.ref.parent.parent.get()).data().customer_id;
    // Create a charge using the pushId as the idempotency key
    // to protect against double charges.
    const idempotencyKey = context.params.pushId;
    const payment = await stripe.paymentIntents.create(
      {
        amount,
        currency,
        customer,
        payment_method,
        off_session: false,
        confirm: true,
        confirmation_method: 'manual',
      },
      { idempotencyKey }
    );
    // If the result is successful, write it back to the database.
    await snap.ref.set(payment);
  } catch (error) {
    // We want to capture errors and render them in a user-friendly way, while
    // still logging an exception with StackDriver
    console.log(error);
    await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
    await reportError(error, { user: context.params.userId });
  }
});

// [END chargecustomer]

/**
 * When 3D Secure is performed, we need to reconfirm the payment
 * after authentication has been performed.
 *
 * @see https://stripe.com/docs/payments/accept-a-payment-synchronously#web-confirm-payment
 */

exports.confirmStripePayment = functions.firestore
  .document('customers/{userId}/payments/{pushId}')
  .onUpdate(async (change, context) => {
    if (change.after.data().status === 'requires_confirmation') {
      const payment = await stripe.paymentIntents.confirm(
        change.after.data().id
      );
      change.after.ref.set(payment);
    }
  });


  /**
 * When a user deletes their account, clean up after them
 */
exports.cleanupUser = functions.auth.user().onDelete(async (user) => {
  const dbRef = admin.firestore().collection('customers');
  const customer = (await dbRef.doc(user.uid).get()).data();
  await stripe.customers.del(customer.customer_id);
  // Delete the customers payments & payment methods in firestore.
  const snapshot = await dbRef
    .doc(user.uid)
    .collection('payment_methods')
    .get();
  snapshot.forEach((snap) => snap.ref.delete());
  await dbRef.doc(user.uid).delete();
  return;
});



/**
 * To keep on top of errors, we should raise a verbose error report with Stackdriver rather
 * than simply relying on console.error. This will calculate users affected + send you email
 * alerts, if you've opted into receiving them.
 */

// [START reporterror]

function reportError(err, context = {}) {
  // This is the name of the StackDriver log stream that will receive the log
  // entry. This name can be any valid log stream name, but must contain "err"
  // in order for the error to be picked up by StackDriver Error Reporting.
  const logName = 'errors';
  const log = logging.log(logName);

  // https://cloud.google.com/logging/docs/api/ref_v2beta1/rest/v2beta1/MonitoredResource
  const metadata = {
    resource: {
      type: 'cloud_function',
      labels: { function_name: process.env.FUNCTION_NAME },
    },
  };

  // https://cloud.google.com/error-reporting/reference/rest/v1beta1/ErrorEvent
  const errorEvent = {
    message: err.stack,
    serviceContext: {
      service: process.env.FUNCTION_NAME,
      resourceType: 'cloud_function',
    },
    context: context,
  };

  // Write the error log entry
  return new Promise((resolve, reject) => {
    log.write(log.entry(metadata, errorEvent), (error) => {
      if (error) {
        return reject(error);
      }
      return resolve();
    });
  });
}

// [END reporterror]

/**
 * Sanitize the error message for the user.
 */
function userFacingMessage(error) {
  return error.type
    ? error.message
    : 'An error occurred, developers have been alerted';
}


/** MOTIVATOR */

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


