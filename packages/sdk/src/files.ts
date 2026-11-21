import { createReadStream, createWriteStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { SecureCloudError, errorFrom } from "./errors.js";
import { Http, segment, type Body } from "./http.js";
import type { ServerResponse } from "node:http";

export interface FileInfo {
  id: string;
  size: number;
  name: string | null;
  contentType: string;
  createdAt: string;
}

export interface MulterFile {
  originalname: string;
  mimetype: string;
  path?: string;
  buffer?: Buffer;
}

export type UploadSource =
  | string
  | Buffer
  | Uint8Array
  | Readable
  | ReadableStream<Uint8Array>
  | MulterFile;

export interface UploadOptions {
  name?: string;
  contentType?: string;
}

const TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

const guessType = (name: string | undefined) =>
  (name && TYPES[extname(name).toLowerCase()]) ?? "application/octet-stream";

const isMulterFile = (value: unknown): value is MulterFile =>
  typeof value === "object" &&
  value !== null &&
  "originalname" in value &&
  ("buffer" in value || "path" in value);

export class Files {
  constructor(private readonly http: Http) {}

  async upload(
    source: UploadSource,
    options: UploadOptions = {},
  ): Promise<FileInfo> {
    let name = options.name;
    let contentType = options.contentType;
    let body: Body;
    let stream = false;

    if (typeof source === "string") {
      try {
        await stat(source);
      } catch {
        throw new SecureCloudError(
          0,
          "FILE_NOT_FOUND",
          `No file at ${source}.`,
        );
      }
      name ??= basename(source);
      body = Readable.toWeb(
        createReadStream(source),
      ) as ReadableStream<Uint8Array>;
      stream = true;
    } else if (isMulterFile(source)) {
      name ??= source.originalname;
      contentType ??= source.mimetype;
      if (source.buffer) {
        body = new Uint8Array(source.buffer);
      } else {
        body = Readable.toWeb(
          createReadStream(source.path!),
        ) as ReadableStream<Uint8Array>;
        stream = true;
      }
    } else if (source instanceof Uint8Array) {
      body = new Uint8Array(source);
    } else if (source instanceof Readable) {
      const incoming = source as Readable & {
        headers?: Record<string, string | string[] | undefined>;
      };
      const header = incoming.headers?.["content-type"];
      if (typeof header === "string") contentType ??= header;
      body = Readable.toWeb(source) as ReadableStream<Uint8Array>;
      stream = true;
    } else {
      body = source;
      stream = true;
    }

    const headers: Record<string, string> = {
      "content-type": contentType ?? guessType(name),
    };
    if (name) headers["x-file-name"] = encodeURIComponent(name);
    return this.http.json<FileInfo>("/v1/storage/files", {
      method: "POST",
      headers,
      body,
      stream,
      timeout: false,
    });
  }

  async list(): Promise<FileInfo[]> {
    const files: FileInfo[] = [];
    let cursor: string | null = null;
    do {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const page: { files: FileInfo[]; nextCursor: string | null } =
        await this.http.json(`/v1/storage/files?${query.toString()}`);
      files.push(...page.files);
      cursor = page.nextCursor;
    } while (cursor);
    return files;
  }

  get(id: string): Promise<FileInfo> {
    return this.http.json<FileInfo>(
      `/v1/storage/files/${segment(id)}/metadata`,
    );
  }

  async stream(id: string): Promise<Readable> {
    const response = await this.http.call(`/v1/storage/files/${segment(id)}`, {
      timeout: false,
    });
    if (!response.body) throw await errorFrom(response);
    return Readable.fromWeb(response.body);
  }

  async download(id: string, toPath: string): Promise<void> {
    await pipeline(await this.stream(id), createWriteStream(toPath));
  }

  async send(res: ServerResponse, id: string): Promise<void> {
    const info = await this.get(id);
    const body = await this.stream(id);
    const name = (info.name ?? info.id).replace(/[\r\n"]/g, "");
    const ascii = name.replace(/[^\x20-\x7e]/g, "_");
    res.statusCode = 200;
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-length", String(info.size));
    res.setHeader(
      "content-disposition",
      `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    await pipeline(body, res);
  }

  async delete(id: string): Promise<void> {
    await this.http.call(`/v1/storage/files/${segment(id)}`, {
      method: "DELETE",
    });
  }

  usage(): Promise<{
    usedBytes: number;
    reservedBytes: number;
    limitBytes: number;
  }> {
    return this.http.json("/v1/storage/usage");
  }
}
