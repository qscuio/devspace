type ProgressToken = string | number;

interface ToolProgressExtra {
  _meta?: {
    progressToken?: ProgressToken;
  };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: ProgressToken;
      progress: number;
      total?: number;
      message?: string;
    };
  }) => Promise<void>;
}

interface ToolProgressUpdate {
  progress: number;
  total?: number;
  message?: string;
}

export async function sendToolProgress(
  extra: ToolProgressExtra | undefined,
  update: ToolProgressUpdate,
): Promise<boolean> {
  const progressToken = extra?._meta?.progressToken;
  if (progressToken === undefined || !extra?.sendNotification) return false;

  const params: {
    progressToken: ProgressToken;
    progress: number;
    total?: number;
    message?: string;
  } = {
    progressToken,
    progress: update.progress,
  };
  if (update.total !== undefined) params.total = update.total;
  if (update.message) params.message = update.message;

  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params,
    });
    return true;
  } catch {
    return false;
  }
}
