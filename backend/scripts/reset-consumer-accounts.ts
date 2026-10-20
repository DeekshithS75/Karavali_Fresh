import 'dotenv/config';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { config } from '../src/config.js';
import { ConsumerModel, ConsumerSessionModel, NotificationModel, OtpChallengeModel, ProduceModel, ProduceRequestModel, PushTokenModel } from '../src/models/index.js';

const args = new Set(process.argv.slice(2));
const expected = (name: string) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  if (!config.MONGODB_URI) throw new Error('database_not_configured');
  if (config.NODE_ENV !== 'development') throw new Error('reset_requires_development_environment');
  if (!args.has('--confirm')) {
    await mongoose.connect(config.MONGODB_URI);
    const consumers = await ConsumerModel.countDocuments();
    const consumerRecords = await ConsumerModel.find({}).select('_id').lean().exec() as Array<{ _id: mongoose.Types.ObjectId }>;
    const consumerIds = consumerRecords.map((consumer) => consumer._id);
    const [sessions, challenges, pushTokens, consumerNotifications, requests, pendingRequests, acceptedRequests] = await Promise.all([
      ConsumerSessionModel.countDocuments({ consumerId: { $in: consumerIds } }),
      OtpChallengeModel.countDocuments({ purpose: { $in: ['consumer_login', 'consumer_registration'] } }),
      PushTokenModel.countDocuments({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }),
      NotificationModel.countDocuments({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }),
      ProduceRequestModel.countDocuments({ buyerId: { $in: consumerIds } }),
      ProduceRequestModel.countDocuments({ buyerId: { $in: consumerIds }, status: 'pending' }),
      ProduceRequestModel.countDocuments({ buyerId: { $in: consumerIds }, status: 'accepted' }),
    ]);
    const farmers = await mongoose.connection.collection('farmers').countDocuments();
    const listings = await ProduceModel.countDocuments();
    console.log(JSON.stringify({ mode: 'dry-run', database: mongoose.connection.name, consumers, sessions, challenges, pushTokens, consumerNotifications, requests, pendingRequests, acceptedRequests, farmers, listings, action: 'No data changed. Add --confirm --expected-database=<name> --expected-consumers=<count> to execute.' }));
    await mongoose.disconnect();
    return;
  }

  await mongoose.connect(config.MONGODB_URI);
  const database = mongoose.connection.name;
  if (!expected('expected-database') || expected('expected-database') !== database) throw new Error('expected_database_mismatch');
  const [consumers, farmerCountBefore, listingsBefore] = await Promise.all([
    ConsumerModel.find({}).lean().exec(),
    mongoose.connection.collection('farmers').countDocuments(),
    ProduceModel.countDocuments(),
  ]);
  if (expected('expected-consumers') !== String(consumers.length)) throw new Error('expected_consumer_count_mismatch');
  if (database !== 'test' && database !== 'development') throw new Error('database_name_not_allowed');
  const consumerIds = consumers.map((consumer) => consumer._id);
  const requests = await ProduceRequestModel.find({ buyerId: { $in: consumerIds } }).lean().exec();
  const requestIds = requests.map((request) => request._id);
  const [sessions, challenges, pushTokens, notices, farmerNotices, attempts] = await Promise.all([
    ConsumerSessionModel.find({ consumerId: { $in: consumerIds } }).lean().exec(),
    OtpChallengeModel.find({ purpose: { $in: ['consumer_login', 'consumer_registration'] } }).lean().exec(),
    PushTokenModel.find({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }).lean().exec(),
    NotificationModel.find({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }).lean().exec(),
    NotificationModel.find({ recipientRole: 'farmer', requestId: { $in: requestIds } }).lean().exec(),
    mongoose.connection.collection('callattempts').find({ requestId: { $in: requestIds } }).toArray(),
  ]);
  const backupDir = join(homedir(), '.codex', 'backups');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const filename = `karavali-consumer-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const backupPath = join(backupDir, filename);
  await writeFile(backupPath, JSON.stringify({ database, createdAt: new Date().toISOString(), consumers, sessions, pushTokens, requests, consumerNotifications: notices, farmerNotificationsForRequests: farmerNotices, callAttempts: attempts }, null, 2), { mode: 0o600, flag: 'wx' });
  await chmod(backupPath, 0o600);

  const legacyIndexes = await ConsumerModel.collection.indexes();
  for (const index of legacyIndexes) {
    if (index.name !== '_id_' && index.key?.email) await ConsumerModel.collection.dropIndex(index.name!);
  }

  const pendingIds = requests.filter((request) => request.status === 'pending').map((request) => request._id);
  if (pendingIds.length) await ProduceRequestModel.updateMany({ _id: { $in: pendingIds }, status: 'pending' }, { $set: { status: 'cancelled', decisionReason: 'buyer_account_reset', decidedAt: new Date() } });
  await Promise.all([
    ConsumerSessionModel.deleteMany({ consumerId: { $in: consumerIds } }),
    OtpChallengeModel.deleteMany({ purpose: { $in: ['consumer_login', 'consumer_registration'] } }),
    PushTokenModel.deleteMany({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }),
    NotificationModel.deleteMany({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }),
    ConsumerModel.deleteMany({ _id: { $in: consumerIds } }),
  ]);
  await ConsumerModel.createIndexes();
  const [remainingConsumers, remainingSessions, remainingPushTokens, remainingChallenges, remainingPendingRequests, farmerCountAfter, listingsAfter] = await Promise.all([
    ConsumerModel.countDocuments(), ConsumerSessionModel.countDocuments({ consumerId: { $in: consumerIds } }),
    PushTokenModel.countDocuments({ recipientRole: 'consumer', recipientId: { $in: consumerIds } }),
    OtpChallengeModel.countDocuments({ purpose: { $in: ['consumer_login', 'consumer_registration'] } }),
    ProduceRequestModel.countDocuments({ buyerId: { $in: consumerIds }, status: 'pending' }),
    mongoose.connection.collection('farmers').countDocuments(), ProduceModel.countDocuments(),
  ]);
  if (remainingConsumers !== 0 || remainingSessions !== 0 || remainingPushTokens !== 0 || remainingChallenges !== 0 || remainingPendingRequests !== 0 || farmerCountAfter !== farmerCountBefore || listingsAfter !== listingsBefore) throw new Error('post_reset_invariant_failed');
  console.log(JSON.stringify({ mode: 'completed', database, consumersRemoved: consumers.length, sessionsRemoved: sessions.length, pushTokensRemoved: pushTokens.length, phoneChallengesRemoved: challenges.length, consumerNotificationsRemoved: notices.length, pendingRequestsCancelled: pendingIds.length, acceptedAndHistoricalRequestsPreserved: requests.length - pendingIds.length, farmerNotificationsPreserved: farmerNotices.length, callAttemptsPreserved: attempts.length, farmersPreserved: farmerCountAfter, listingsPreserved: listingsAfter, privateBackup: backupPath }));
  await mongoose.disconnect();
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : 'reset_failed');
  await mongoose.disconnect();
  process.exitCode = 1;
});
