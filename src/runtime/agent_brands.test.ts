import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_BRANDS, agentBrand } from "./agent_brands";

const included = readFileSync(
  "src-tauri/src/acp_client/first_release.rs",
  "utf8",
)
  .split("const INCLUDED: &[&str] = &[")[1]
  .split("];")[0]
  .match(/"[a-z0-9-]+"/g)!
  .map((id) => JSON.parse(id) as string);

describe("reviewed Agent branding", () => {
  it("covers the current directory and preserves branding for historical conversations", () => {
    expect(included).toHaveLength(23);
    const supportedBrands = [
      ...included,
      "kimi",
      "nova",
      "qwen-code",
      "dimcode",
      "factory-droid",
      "poolside",
    ];
    expect(Object.keys(AGENT_BRANDS).sort()).toEqual(supportedBrands.sort());
    for (const id of supportedBrands) {
      const brand = agentBrand({ id: `registry:${id}` });
      expect(brand).toBe(AGENT_BRANDS[id]);
      expect(brand?.description).toMatch(/[\u4e00-\u9fff]/);
      expect(brand!.description.length).toBeLessThanOrEqual(40);
      expect(brand?.description).not.toMatch(
        /runtime|host|acp|原生|绑定|代次|投影|占用|working copy|session|turn|构建|引用|对账|沉降|上游|sidecar|adapter|json|握手|envelope/i,
      );
      expect(brand?.sourceUrl).toMatch(/^https:\/\//);
      expect(brand?.logo).toMatch(/^\/agents\/[a-z0-9-]+\.(svg|png|jpg)$/);
      const artwork = readFileSync(`public${brand!.logo}`);
      if (brand!.logo.endsWith(".svg")) {
        const svg = artwork.toString("utf8");
        expect(svg).toContain("<svg");
        expect(svg).toMatch(/viewBox=/);
        expect(svg).not.toMatch(
          /<script|<foreignObject|\bon\w+=|(?:href|src)=["']https?:/i,
        );
      } else if (brand!.logo.endsWith(".png")) {
        expect(artwork.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
        expect(artwork.readUInt32BE(16)).toBeGreaterThanOrEqual(32);
        expect(artwork.readUInt32BE(20)).toBeGreaterThanOrEqual(32);
      } else {
        expect(artwork.subarray(0, 3).toString("hex")).toBe("ffd8ff");
        expect(artwork.subarray(-2).toString("hex")).toBe("ffd9");
      }
    }
  });

  it("preserves official colors while retaining genuine monochrome brands", () => {
    const colored = [
      "amp-acp",
      "antigravity-acp",
      "claude-acp",
      "codebuddy-code",
      "dimcode",
      "dirac",
      "fast-agent",
      "gemini",
      "kilo",
      "kimchi",
      "kimi",
      "minimax-code",
      "mistral-vibe",
      "nova",
      "pi-acp",
      "poolside",
      "qwen-code",
      "sigit",
    ];
    for (const id of colored) expect(AGENT_BRANDS[id].monochrome).toBe(false);
    expect(AGENT_BRANDS.cursor.monochrome).toBe(false);
    expect(AGENT_BRANDS["codex-acp"].monochrome).toBe(true);
    expect(AGENT_BRANDS.opencode.monochrome).toBe(true);
    expect(
      new Set(Object.values(AGENT_BRANDS).map((brand) => brand.description))
        .size,
    ).toBe(29);
  });

  it("resolves existing built-ins and explicit registry identities without matching a name or custom command", () => {
    expect(agentBrand({ id: "codex" })).toBe(AGENT_BRANDS["codex-acp"]);
    expect(agentBrand({ id: "pi" })).toBe(AGENT_BRANDS["pi-acp"]);
    expect(agentBrand({ id: "opencode" })).toBe(AGENT_BRANDS.opencode);
    expect(agentBrand({ id: "saved-id", registryId: "cline" })).toBe(
      AGENT_BRANDS.cline,
    );
    expect(agentBrand({ id: "custom-codex" })).toBeUndefined();
    expect(agentBrand({ id: "codex", custom: true })).toBeUndefined();
    expect(
      agentBrand({ id: "saved-id", registryId: "cline", custom: true }),
    ).toBeUndefined();
    expect(agentBrand({ id: "unreviewed-agent" })).toBeUndefined();
    expect(agentBrand({ id: "registry:crow-cli" })).toBeUndefined();
  });
});
