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

exports.createConnectedAccount = functions.firestore.document('/chefs/{userId}').onCreate(async (snap, context) => {

  const { first_name, last_name, email_address, phone, dob, ssn_last_4,
     city, line1, postal_code, state, ip} = snap.data();
  const userId = context.params.userId;

  try {
    const account = await stripe.accounts.create({
      type: 'custom',
      country: 'US',
      email: email_address,
      business_type: 'individual',
      individual: {
        email: email_address,
        first_name: first_name, 
        last_name: last_name,
        ssn_last_4: ssn_last_4,
        phone: phone, 
        address: {
          city: city,
          country: 'US',
          line1: line1,
          line2: null,
          postal_code: postal_code,
          state: state
        },
        dob: {
          day: dob[0],
          month: dob[1],
          year: dob[2]
        },
      }, 
      business_profile: {
        mcc: "5734",
        url: "https://instagram.com/lidora",
        product_description: "Product description",
      },
      capabilities: {
        card_payments: {requested: true},
        transfers: {requested: true},
      },
      tos_acceptance: {
        date: Math.floor(Date.now() / 1000),
        ip: ip,
      },
    });
    await snap.ref.set({account_id: account.id}, { merge: true}); 
    return; 
   } catch (error) { 
    await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
    await reportError(error, { user: context.params.userId });
   }
});

// Card needs to be a Debit card, not a credit card

exports.createExternalAccount = functions.firestore
.document('/chefs/{userId}/external_accounts/{token}')
.onCreate(async (snap, context) => {
  const userId = context.params.userId; 
  const token = context.params.token; 
  const accountRef = admin.firestore().collection("chefs");
  const account_id = (await accountRef.doc(userId).get()).data().account_id;
try {
  const bankAccount = await stripe.accounts.createExternalAccount(
    account_id,
    {
      external_account: token,
    }
  );
  await snap.ref.set(bankAccount);
  return;
} catch (error) {
    console.log(userFacingMessage(error));
    await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
    await reportError(error, { user: context.params.userId });
  }
});


exports.createStripeCustomer = functions.auth.user().onCreate(async (user) => {
  const customer = await stripe.customers.create({ email: user.email });
  const intent = await stripe.setupIntents.create({
    customer: customer.id,
  });

  const res = await admin.firestore().collection('customers').doc(user.uid).collection("orders").doc();

  await admin.firestore().collection('customers').doc(user.uid).set({
    customer_id: customer.id,
    setup_secret: intent.client_secret,
    email_address: user.email, 
    order_id: res.id
  });
  return;
});


exports.attachPaymentMethod = functions.firestore
  .document('/customers/{userId}/payment_methods/{pushId}')
  .onCreate(async (snap, context) => {
    try {
      const paymentMethodId = context.params.pushId;
      const customer = (await snap.ref.parent.parent.get()).data().customer_id;
      await stripe.paymentMethods.attach(
        paymentMethodId, {
          customer: customer,
        }
      );
      await snap.ref.parent.parent.set({ primary_card: paymentMethodId}, { merge: true });
      return;
    } catch (error) {
      await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
      await reportError(error, { user: context.params.userId });
    }
  });

  exports.detachPaymentMethod = functions.firestore
  .document('/customers/{userId}/payment_methods/{pushId}')
  .onDelete(async (snap, context) => {
    try {
      const paymentMethodId = context.params.pushId;
      const paymentMethod = await stripe.paymentMethods.detach(
        paymentMethodId, 
      );
      return; 
    } catch (error) {
      await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
      await reportError(error, { user: context.params.userId });
    }
  });
  

  exports.updatePaymentMethod = functions.firestore
  .document('/customers/{userId}/payment_methods/{pushId}')
  .onUpdate(async (snap, context) => {
     try {
 
      const paymentMethodId = context.params.pushId;

      const old_exp_month = snap.before.data().month;
      const old_exp_year = snap.before.data().year; 
      const exp_month = snap.after.data().month; 
      const exp_year = snap.after.data().year; 

      if (old_exp_month !== exp_month || old_exp_year !== exp_year) {
        const paymentMethod = await stripe.paymentMethods.update(paymentMethodId, 
          {
          card: {
            exp_month: exp_month, 
            exp_year: exp_year, 
          }
         });
        console.log("PAYMENT METHOD: ", paymentMethod);
      }
      return;
     } catch (error) {
      await snap.after.ref.set({ error: userFacingMessage(error) }, { merge: true });
      await reportError(error, { user: context.params.userId });
    }
  }); 

  exports.updateDefaultPaymentMethod = functions.firestore
  .document('/customers/{userId}/payment_methods/{pushId}')
  .onUpdate(async (snap, context) => {
    const before_primary = snap.after.data().primary; 
    const primary = snap.after.data().primary; 
    if (before_primary !== primary && primary === true) {
      try {
        const paymentMethodId = context.params.pushId;
        const customerId = (await snap.after.ref.parent.parent.get()).data().customer_id;
  
          const customer = await stripe.customers.update(customerId, {
            invoice_settings: {
              default_payment_method: paymentMethodId,
            },
          });
        return;
      } catch (error) {
        await snap.after.ref.set({ error: userFacingMessage(error) }, { merge: true });
        await reportError(error, { user: context.params.userId });
      }
    } 
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
      const customer = (await snap.ref.parent.parent.get()).data().customer_id;

      const paymentMethod = await stripe.paymentMethods.retrieve(
        paymentMethodId, 
      );
      await snap.ref.set({ 
        brand: paymentMethod.card.brand, 
        last4: paymentMethod.card.last4, 
        month: paymentMethod.card.exp_month, 
        year:  paymentMethod.card.exp_year,
        primary: true, 
       }, { merge: true });
      // Create a new SetupIntent so the customer can add a new method next time.
      const intent = await stripe.setupIntents.create({
        customer: customer,
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
.document('customers/{userId}/payments/{pushId}').onCreate(async (snap, context) => {
  const { subtotal, total, currency, payment_method, destination } = snap.data();
  try {
    // Look up the Stripe customer id.
    const userId = context.params.userId; 
    const dbRef = admin.firestore().collection('customers');
    const customer = (await snap.ref.parent.parent.get()).data().customer_id;
    const orderId = (await snap.ref.parent.parent.get()).data().order_id;
    const receipt_email = (await dbRef.doc(userId).get()).data().email_address;

    // Create a charge using the pushId as the idempotency key
    // to protect against double charges.
    const idempotencyKey = context.params.pushId;
    const roundSubtotal =  Math.round(subtotal * 100);
    const roundtotal =  Math.round(total * 100);

    const payment = await stripe.paymentIntents.create(
      {
        payment_method_data: {
          type: 'card',  
          card: {
            token: payment_method,
          }
        }, 
        customer: customer,
        amount: roundtotal,
        currency: currency,
        off_session: false,
        confirm: true,
        receipt_email: receipt_email,
        transfer_data: {
          amount: roundSubtotal,
          destination: "acct_1HMaiNGAaZwhOLs7",
        },
      },
      { 
        idempotencyKey,
       }
    );
    // If the result is successful, delete order and write payment back to the database.

    await admin.firestore().collection("customers").doc(userId).collection("orders").doc(orderId).delete();
    await deleteCollection(admin.firestore(), userId, orderId, 10); 
    await snap.ref.set(payment);
    return;
  } catch (error) {
    // We want to capture errors and render them in a user-friendly way, while
    // still logging an exception with StackDriver
    console.log(error);
    await snap.ref.set({ error: userFacingMessage(error) }, { merge: true });
    await reportError(error, { user: context.params.userId });
  }
});

async function deleteCollection(db, userId, orderId, batchSize) {

  const collectionRef = db.collection("customers").doc(userId).collection("orders").doc(orderId).collection("items");

  const query = collectionRef.limit(batchSize);

  return new Promise((resolve, reject) => {
    deleteQueryBatch(db, query, resolve).catch(reject);
  });
}

async function deleteQueryBatch(db, query, resolve) {
  const snapshot = await query.get();

  const batchSize = snapshot.size;
  if (batchSize === 0) {
    // When there are no documents left, we are done
    resolve();
    return;
  }

  // Delete documents in a batch
  const batch = db.batch();
  snapshot.docs.forEach((doc) => {
    batch.delete(doc.ref);
  });
  await batch.commit();

  // Recurse on the next process tick, to avoid
  // exploding the stack.
  process.nextTick(() => {
    deleteQueryBatch(db, query, resolve);
  });
}

// [END chargecustomer]

/**
 * When 3D Secure is performed, we need to reconfirm the payment
 * after authentication has been performed.
 *
 */

exports.confirmStripePayment = functions.firestore
  .document('customers/{userId}/payments/{pushId}')
  .onUpdate(async (change, context) => {
    if (change.after.data().status === 'requires_confirmation') {
      const payment = await stripe.paymentIntents.confirm(
        change.after.data().id
      );
      change.after.ref.set(payment)
      ;
    }
  });

  // [START Creating transfer


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


