import assert from "node:assert/strict";
import { sendToolProgress } from "./tool-progress.js";

{
  const notifications: unknown[] = [];
  const sent = await sendToolProgress(
    {
      _meta: { progressToken: "token-1" },
      async sendNotification(notification) {
        notifications.push(notification);
      },
    },
    { progress: 1, total: 3, message: "Opening workspace" },
  );

  assert.equal(sent, true);
  assert.deepEqual(notifications, [
    {
      method: "notifications/progress",
      params: {
        progressToken: "token-1",
        progress: 1,
        total: 3,
        message: "Opening workspace",
      },
    },
  ]);
}

{
  const notifications: unknown[] = [];
  const sent = await sendToolProgress(
    {
      async sendNotification(notification) {
        notifications.push(notification);
      },
    },
    { progress: 1, message: "No progress token" },
  );

  assert.equal(sent, false);
  assert.deepEqual(notifications, []);
}

{
  const sent = await sendToolProgress(
    {
      _meta: { progressToken: 42 },
      async sendNotification() {
        throw new Error("client closed stream");
      },
    },
    { progress: 1, message: "Optional progress" },
  );

  assert.equal(sent, false);
}
