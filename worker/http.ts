export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function json(data: unknown, status = 200) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}
export function databaseQuotaResponse(error: unknown): Response | null {
  if (
    !(error instanceof Error) ||
    !/Exceeded allowed rows (?:read|written) in Durable Objects free tier/i.test(error.message)
  )
    return null;
  const response = json(
    {
      error:
        'Cloudflare’s daily database quota is exhausted. Database reads and moderation are unavailable until the quota resets at midnight UTC or the Workers plan is upgraded.',
      code: 'DATABASE_DAILY_QUOTA',
    },
    503,
  );
  // Retry slowly so a plan upgrade is detected without hammering an exhausted database.
  response.headers.set('Retry-After', '300');
  return response;
}
export async function readJson(request: Request, limit = 1_000_000): Promise<unknown> {
  if (!request.headers.get('content-type')?.startsWith('application/json'))
    throw new HttpError(415, 'Send application/json.');
  if (Number(request.headers.get('content-length')) > limit)
    throw new HttpError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON body is required.');
  let length = 0;
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new HttpError(413, 'Request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}
