import { PushTokenModel } from '../models/index.js';

type PushRole = 'consumer' | 'farmer';

export async function sendAccountPush(role: PushRole, accountId: unknown, input: {
  title: string; body: string; url: string; notificationId: string; requestId: string; categoryId?: string;
}) {
  try {
    const tokens = await PushTokenModel.find({ recipientRole: role, recipientId: accountId, disabledAt: null })
      .select('_id token').lean().exec() as unknown as Array<{ _id: unknown; token: string }>;
    if (!tokens.length) return;
    for (let offset = 0; offset < tokens.length; offset += 100) {
      const batch = tokens.slice(offset, offset + 100);
      const response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip, deflate' },
        body: JSON.stringify(batch.map(({ token }) => ({
          to: token, title: input.title, body: input.body, sound: 'default', priority: 'high', channelId: 'requests',
          data: { url: input.url, notificationId: input.notificationId, requestId: input.requestId, ...(input.categoryId ? { categoryId: input.categoryId } : {}) },
          ...(input.categoryId ? { categoryId: input.categoryId } : {}),
        }))),
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) continue;
      const payload = await response.json().catch(() => null) as { data?: Array<{ status?: string; details?: { error?: string } }> } | null;
      const invalidIds = batch.filter((_token, index) => payload?.data?.[index]?.details?.error === 'DeviceNotRegistered').map((item) => item._id);
      if (invalidIds.length) await PushTokenModel.updateMany({ _id: { $in: invalidIds } }, { $set: { disabledAt: new Date() } }).exec();
    }
  } catch {
    // In-app notification records are authoritative; transport failure must not undo them.
  }
}
