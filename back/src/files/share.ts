// Nextcloud sharing goes through the OCS API, not WebDAV.
// https://docs.nextcloud.com/server/latest/developer_manual/client_apis/OCS/ocs-share-api.html
import { cleanForContext } from "@/files/format.ts";
import { logger } from "@/utils/logger.ts";

export type ShareMode = "user" | "link";

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function authHeader(): string {
  const user = required("NEXTCLOUD_USERNAME");
  const password = required("NEXTCLOUD_PASSWORD");
  return `Basic ${btoa(`${user}:${password}`)}`;
}

function endpoint(): string {
  return `${
    required("NEXTCLOUD_URL")
  }/ocs/v2.php/apps/files_sharing/api/v1/shares`;
}

export type ShareRequest = {
  path: string;
  shareType: 0 | 3;
  shareWith?: string;
  permissions: 1;
  /** YYYY-MM-DD, public links only */
  expireDate?: string;
};

/** Nextcloud wants a date, not a timestamp: YYYY-MM-DD in UTC. */
export function expiryDate(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** Read-only: 1. Link shares have no recipient, user shares get the owner. */
export function shareRequest(
  path: string,
  mode: ShareMode,
  owner: string,
  expiresInDays?: number,
): ShareRequest {
  if (mode === "user") {
    return { path, shareType: 0, shareWith: owner, permissions: 1 };
  }
  const request: ShareRequest = { path, shareType: 3, permissions: 1 };
  if (expiresInDays !== undefined) {
    request.expireDate = expiryDate(expiresInDays);
  }
  return request;
}

type OcsMeta = { status?: string; statuscode?: number; message?: string };

type OcsResponse = {
  ocs?: {
    meta?: OcsMeta;
    data?: {
      id?: string;
      url?: string;
      token?: string;
      file_target?: string;
      expiration?: string | null;
    };
  };
};

type OcsEnvelope = { ocs?: { meta?: OcsMeta; data?: unknown } };

export type ShareResult = {
  id: string;
  url?: string;
  target?: string;
  expiration?: string;
};

export function parseShareResponse(json: unknown): ShareResult {
  const response = json as OcsResponse;
  const meta = response.ocs?.meta;
  if (meta?.status !== "ok" || !response.ocs?.data?.id) {
    throw new Error(
      meta?.message
        ? `Nextcloud refused the share: ${cleanForContext(meta.message)}`
        : "Nextcloud refused the share",
    );
  }
  const data = response.ocs.data;
  return {
    id: String(data.id),
    url: data.url,
    target: data.file_target,
    ...(data.expiration ? { expiration: data.expiration } : {}),
  };
}

/**
 * One OCS call. Nextcloud answers HTTP 200 even when it refuses the operation,
 * putting the real outcome in `ocs.meta.status`, so `response.ok` alone is not
 * enough. `refusal` completes "Nextcloud refused ..." in the error.
 */
async function ocsRequest(
  url: string,
  refusal: string,
  options: { method: string; body?: URLSearchParams } = { method: "GET" },
): Promise<OcsEnvelope> {
  const headers: Record<string, string> = {
    "OCS-APIRequest": "true",
    "Authorization": authHeader(),
    "Accept": "application/json",
  };
  if (options.body) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const response = await fetch(url, {
    method: options.method,
    headers,
    body: options.body,
  });
  if (!response.ok) {
    throw new Error(`Nextcloud answered ${response.status}`);
  }

  const json = await response.json() as OcsEnvelope;
  const meta = json.ocs?.meta;
  if (meta?.status !== "ok") {
    throw new Error(
      meta?.message
        ? `Nextcloud refused ${refusal}: ${cleanForContext(meta.message)}`
        : `Nextcloud refused ${refusal}`,
    );
  }
  return json;
}

export async function createShare(
  path: string,
  mode: ShareMode,
  expiresInDays?: number,
): Promise<ShareResult> {
  const body = new URLSearchParams();
  for (
    const [key, value] of Object.entries(
      shareRequest(
        path,
        mode,
        required("NEXTCLOUD_OWNER"),
        mode === "link" ? expiresInDays : undefined,
      ),
    )
  ) {
    body.set(key, String(value));
  }

  const response = await ocsRequest(
    `${endpoint()}?format=json`,
    "the share",
    { method: "POST", body },
  );
  return parseShareResponse(response);
}

type OcsSharesResponse = {
  ocs?: {
    meta?: { status?: string; statuscode?: number; message?: string };
    data?: Array<{
      id?: string | number;
      url?: string;
      path?: string;
      file_target?: string;
      expiration?: string | null;
      share_type?: number;
    }>;
  };
};

export type ShareInfo = {
  id: string;
  shareType: number;
  url?: string;
  path?: string;
  target?: string;
  expiration?: string;
};

/** Every share the account owns, link and user shares alike. */
export async function listShares(): Promise<ShareInfo[]> {
  const json = await ocsRequest(
    `${endpoint()}?format=json`,
    "to list shares",
  ) as OcsSharesResponse;

  const data = Array.isArray(json.ocs?.data) ? json.ocs.data : [];
  return data
    .filter((share) => share.id !== undefined)
    .map((share) => ({
      id: String(share.id),
      shareType: share.share_type ?? -1,
      url: share.url,
      path: share.path,
      target: share.file_target,
      expiration: share.expiration ?? undefined,
    }));
}

/**
 * Nextcloud writes expirations as "YYYY-MM-DD HH:MM:SS" in UTC, with no zone,
 * while `expiryDate` writes a UTC date. Returns null when it cannot be read.
 */
export function parseExpiration(value: string): Date | null {
  const text = value.trim();
  if (!text) return null;
  const utc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(" ", "T")}Z`
    : text;
  const date = new Date(utc);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * A share without an expiration date never expires. An expiration we cannot
 * parse is treated as expired: removing one link too early is recoverable,
 * while a link that is never cleaned up is not. It is logged so clean_links is
 * not silently guessing.
 */
export function isExpired(expiration?: string, now = new Date()): boolean {
  if (!expiration) return false;
  const date = parseExpiration(expiration);
  if (!date) {
    logger.warn(
      `Unreadable share expiration "${
        cleanForContext(expiration)
      }"; treating the link as expired.`,
    );
    return true;
  }
  return date.getTime() <= now.getTime();
}

export async function deleteShare(id: string): Promise<void> {
  await ocsRequest(
    `${endpoint()}/${encodeURIComponent(id)}?format=json`,
    "to delete the share",
    { method: "DELETE" },
  );
}
