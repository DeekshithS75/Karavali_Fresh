import mongoose from 'mongoose';
import app from './app.js';
import { config, validateRuntimeConfig } from './config.js';
import { CallAttemptModel, ConsumerModel, ConsumerSessionModel, FarmerModel, FarmerSubscriptionModel, InAppCallModel, MarketPriceObservationModel, NotificationModel, OtpChallengeModel, PendingRegistrationModel, ProduceModel, ProduceRequestModel, PushTokenModel, RateLimitModel, SessionModel } from './models/index.js';
import { initializeOcr, shutdownOcr } from './providers/ocr.js';

async function start() {
  validateRuntimeConfig();
  if (!config.MONGODB_URI) throw new Error('MONGODB_URI is required to start the Farmer API');
  await mongoose.connect(config.MONGODB_URI, { autoIndex: false, serverSelectionTimeoutMS: 10_000 });
  await Promise.all([CallAttemptModel, ConsumerModel, ConsumerSessionModel, FarmerModel, FarmerSubscriptionModel, InAppCallModel, MarketPriceObservationModel, NotificationModel, OtpChallengeModel, PendingRegistrationModel, ProduceModel, ProduceRequestModel, PushTokenModel, RateLimitModel, SessionModel].map((model) => model.init()));
  await Promise.all([CallAttemptModel.createIndexes(), ConsumerModel.createIndexes(), FarmerSubscriptionModel.createIndexes(), InAppCallModel.createIndexes(), NotificationModel.createIndexes(), ProduceRequestModel.createIndexes(), PushTokenModel.createIndexes()]);
  try {
    await initializeOcr();
  } catch {
    // The API starts in fail-closed mode; capabilities report OCR unavailable.
    process.stderr.write('Farmer OCR engine could not initialize; document registration is disabled.\n');
  }
  const server = app.listen(config.PORT, '0.0.0.0', () => process.stdout.write(`Farmer API listening on ${config.PORT}\n`));
  const close = async () => {
    server.close();
    await shutdownOcr();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

start().catch(() => {
  process.stderr.write('Farmer API could not start. Check database and security configuration.\n');
  process.exitCode = 1;
});
