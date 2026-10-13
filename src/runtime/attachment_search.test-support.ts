import { createHash } from "node:crypto";
import { vi } from "vitest";
import { freshThreadState } from "./session_projection";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
import { AttachmentSearch } from "./attachment_search";
import type { VerifiedFile } from "./file_delivery";
export const deferred = <T>() => {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
export const tick = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
export function setup(texts = ["first needle last", "another needle"]) {
  const s = freshThreadState("saved", "controlled", "/fixture", "native");
  s.items = texts.map((_, i) => ({
    kind: i % 2 ? "agent" : "user",
    id: `m${i}`,
    text: "message without match",
    time: 1,
    streaming: false,
    attachments: [
      { name: `file${i}.txt`, uri: `file:///fixture/file${i}.txt` },
    ],
  }));
  const states = new Map([[s.key, s]]),
    files = new Map<string, VerifiedFile>(),
    bodies = new Map<string, string>();
  texts.forEach((text, i) => {
    const path = `/fixture/file${i}.txt`;
    files.set(path, {
      root: "/fixture",
      path,
      resolvedPath: path,
      name: `file${i}.txt`,
      size: Buffer.byteLength(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      version: `version${i}`,
    });
    bodies.set(path, text);
  });
  const services = {
    inspect: vi.fn(async (path: string) => ({ ...files.get(path)! })),
    read: vi.fn(async (file: VerifiedFile) => ({
      file: { ...file },
      text: bodies.get(file.path)!,
    })),
    check: vi.fn(async (file: VerifiedFile) => ({
      kind: "verified",
      file: { ...file },
    })),
  };
  const candidates = attachmentSearchCandidates([s.key], states).candidates;
  const current = () =>
    candidates.every((c) => attachmentSearchSourceCurrent(c, states));
  return {
    s,
    states,
    files,
    bodies,
    services,
    candidates,
    current,
    search: new AttachmentSearch(services),
  };
}
