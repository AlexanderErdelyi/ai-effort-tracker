const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

interface RequestIdentity {
  requestId?: string;
  responseId?: string;
  modelResponseId?: string;
}

function identity(value: unknown): RequestIdentity {
  if (!object(value)) return {};
  const result = object(value.result) ? value.result : {};
  const metadata = object(result.metadata) ? result.metadata : {};
  return {
    requestId: typeof value.requestId === 'string' ? value.requestId : undefined,
    responseId: typeof value.responseId === 'string' ? value.responseId : undefined,
    modelResponseId: typeof metadata.responseId === 'string' ? metadata.responseId : undefined
  };
}

/** Replay only identity fields; chat text/tool contents never enter the state. */
export function parseChatAliases(text: string): Map<string, string[]> {
  let requests: RequestIdentity[] = [];
  const aliases = new Map<string, Set<string>>();
  const rows = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const collect = (items: RequestIdentity[]) => {
    for (const r of items) {
      if (!r?.modelResponseId) continue;
      const ids = aliases.get(r.modelResponseId) ?? new Set<string>();
      if (r.requestId) ids.add(r.requestId);
      if (r.responseId) ids.add(r.responseId);
      aliases.set(r.modelResponseId, ids);
    }
  };
  for (let i = 0; i < rows.length; i++) {
    if (!rows[i].trim()) continue;
    let patch: unknown;
    try { patch = JSON.parse(rows[i]); } catch {
      if (i === rows.length - 1 && !text.endsWith('\n')) break;
      throw new Error(`Malformed chat identity record at line ${i + 1}`);
    }
    if (!object(patch)) continue;
    if (patch.kind === 0 && object(patch.v)) {
      requests = Array.isArray(patch.v.requests) ? patch.v.requests.map(identity) : [];
      collect(requests);
    } else if (Array.isArray(patch.k) && patch.k[0] === 'requests') {
      const k: unknown[] = patch.k;
      if (k.length === 1 && Array.isArray(patch.v)) {
        if (patch.kind === 1) requests = patch.v.map(identity);
        else if (patch.kind === 2) requests.push(...patch.v.map(identity));
        collect(requests);
      } else if (patch.kind === 1 && typeof k[1] === 'number' &&
                 Number.isInteger(k[1]) && k[1] >= 0 && k[1] < 100_000) {
        const index = k[1];
        if (k.length === 2) requests[index] = identity(patch.v);
        else {
          const request = requests[index] ?? {};
          const field = k.slice(2).join('.');
          if (field === 'requestId' && typeof patch.v === 'string') request.requestId = patch.v;
          if (field === 'responseId' && typeof patch.v === 'string') request.responseId = patch.v;
          if (field === 'result') request.modelResponseId = identity({ result: patch.v }).modelResponseId;
          if (field === 'result.metadata') request.modelResponseId = identity({ result: { metadata: patch.v } }).modelResponseId;
          if (field === 'result.metadata.responseId' && typeof patch.v === 'string') request.modelResponseId = patch.v;
          requests[index] = request;
        }
        collect([requests[index]]);
      }
    }
  }
  return new Map([...aliases].map(([responseId, ids]) => [responseId, [...ids]]));
}
