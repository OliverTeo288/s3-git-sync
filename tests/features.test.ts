import { describe, it, expect } from "vitest";
import type { S3GitSyncSettings } from "../src/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSettings(overrides: Partial<S3GitSyncSettings> = {}): S3GitSyncSettings {
  return {
    s3: {
      authMethod: "static",
      s3AccessKeyID: "AKIAIOSFODNN7EXAMPLE",
      s3SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      s3ProfileName: "default",
      s3Endpoint: "",
      s3Region: "us-east-1",
      s3BucketName: "my-vault-bucket",
      s3Prefix: "",
      forcePathStyle: false,
    },
    ignorePatterns: [".obsidian/workspace.json"],
    showStatusBar: true,
    badgePollIntervalMin: 5,
    ...overrides,
  };
}

// ─── Settings export — credential stripping ───────────────────────────────────
// Mirrors the logic in main.ts exportSettings()

function applyExport(settings: S3GitSyncSettings) {
  const { s3AccessKeyID: _id, s3SecretAccessKey: _secret, ...safeS3 } = settings.s3;
  return { ...settings, s3: safeS3 };
}

describe("settings export — credential stripping", () => {
  it("removes s3AccessKeyID from the exported object", () => {
    const exported = applyExport(makeSettings());
    expect((exported.s3 as Record<string, unknown>)["s3AccessKeyID"]).toBeUndefined();
  });

  it("removes s3SecretAccessKey from the exported object", () => {
    const exported = applyExport(makeSettings());
    expect((exported.s3 as Record<string, unknown>)["s3SecretAccessKey"]).toBeUndefined();
  });

  it("preserves all non-credential S3 fields", () => {
    const settings = makeSettings();
    settings.s3.s3BucketName = "production-vault";
    settings.s3.s3Region = "ap-southeast-1";
    settings.s3.s3Prefix = "my-vault/";
    settings.s3.forcePathStyle = true;
    const exported = applyExport(settings);
    expect(exported.s3.s3BucketName).toBe("production-vault");
    expect(exported.s3.s3Region).toBe("ap-southeast-1");
    expect(exported.s3.s3Prefix).toBe("my-vault/");
    expect(exported.s3.forcePathStyle).toBe(true);
  });

  it("preserves top-level settings fields", () => {
    const settings = makeSettings({ showStatusBar: false, badgePollIntervalMin: 15 });
    settings.ignorePatterns = ["*.tmp", ".obsidian/workspace.json"];
    const exported = applyExport(settings);
    expect(exported.showStatusBar).toBe(false);
    expect(exported.badgePollIntervalMin).toBe(15);
    expect(exported.ignorePatterns).toEqual(["*.tmp", ".obsidian/workspace.json"]);
  });

  it("does not mutate the original settings object", () => {
    const settings = makeSettings();
    applyExport(settings);
    expect(settings.s3.s3AccessKeyID).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(settings.s3.s3SecretAccessKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  it("produces valid JSON when serialised", () => {
    const exported = applyExport(makeSettings());
    expect(() => JSON.stringify(exported)).not.toThrow();
    const reparsed = JSON.parse(JSON.stringify(exported)) as Record<string, unknown>;
    expect((reparsed["s3"] as Record<string, unknown>)["s3AccessKeyID"]).toBeUndefined();
  });
});

// ─── Settings import — credential preservation ────────────────────────────────
// Mirrors the merge logic in main.ts importSettings()

function applyImport(
  current: S3GitSyncSettings,
  imported: Partial<S3GitSyncSettings>
): S3GitSyncSettings {
  const { s3: parsedS3, ...rest } = imported;
  return {
    ...current,
    ...rest,
    s3: {
      ...current.s3,
      ...(parsedS3 ?? {}),
      // Credentials from the current device are always preserved
      s3AccessKeyID: current.s3.s3AccessKeyID,
      s3SecretAccessKey: current.s3.s3SecretAccessKey,
    },
  };
}

describe("settings import — credential preservation", () => {
  it("preserves the existing accessKeyId when the imported file has no credentials", () => {
    const current = makeSettings();
    const imported = applyExport(current); // stripped version, as exported
    const merged = applyImport(current, imported as Partial<S3GitSyncSettings>);
    expect(merged.s3.s3AccessKeyID).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  it("preserves the existing secretAccessKey when the imported file has no credentials", () => {
    const current = makeSettings();
    const imported = applyExport(current);
    const merged = applyImport(current, imported as Partial<S3GitSyncSettings>);
    expect(merged.s3.s3SecretAccessKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  it("updates bucket name and region from the imported file", () => {
    const current = makeSettings();
    const imported: Partial<S3GitSyncSettings> = {
      s3: { ...current.s3, s3BucketName: "new-bucket", s3Region: "ap-southeast-1" },
    };
    const merged = applyImport(current, imported);
    expect(merged.s3.s3BucketName).toBe("new-bucket");
    expect(merged.s3.s3Region).toBe("ap-southeast-1");
  });

  it("updates ignore patterns from the imported file", () => {
    const current = makeSettings();
    const imported: Partial<S3GitSyncSettings> = { ignorePatterns: ["*.tmp", "*.log"] };
    const merged = applyImport(current, imported);
    expect(merged.ignorePatterns).toEqual(["*.tmp", "*.log"]);
  });

  it("updates badgePollIntervalMin from the imported file", () => {
    const current = makeSettings({ badgePollIntervalMin: 5 });
    const imported: Partial<S3GitSyncSettings> = { badgePollIntervalMin: 20 };
    const merged = applyImport(current, imported);
    expect(merged.badgePollIntervalMin).toBe(20);
  });

  it("does not overwrite credentials even if the imported file somehow contains them", () => {
    const current = makeSettings();
    // Simulate a malformed export that still contains credential fields
    const imported: Partial<S3GitSyncSettings> = {
      s3: {
        ...current.s3,
        s3AccessKeyID: "AKIAMALICIOUSKEY9999",
        s3SecretAccessKey: "stolen-secret",
      },
    };
    const merged = applyImport(current, imported);
    expect(merged.s3.s3AccessKeyID).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(merged.s3.s3SecretAccessKey).toBe("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });
});

// ─── Ribbon badge — count formatting ─────────────────────────────────────────
// Mirrors the text logic in main.ts updateRibbonBadge()

function badgeText(count: number): string {
  return count > 99 ? "99+" : String(count);
}

describe("ribbon badge — count formatting", () => {
  it("shows '1' for a single pending change", () => {
    expect(badgeText(1)).toBe("1");
  });

  it("shows '42' for 42 pending changes", () => {
    expect(badgeText(42)).toBe("42");
  });

  it("shows '99' at the boundary (not capped)", () => {
    expect(badgeText(99)).toBe("99");
  });

  it("caps at '99+' for 100 changes", () => {
    expect(badgeText(100)).toBe("99+");
  });

  it("caps at '99+' for very large counts", () => {
    expect(badgeText(9999)).toBe("99+");
  });

  it("returns '0' for zero (badge element itself is hidden for 0 in production)", () => {
    expect(badgeText(0)).toBe("0");
  });
});

// ─── Version history — ObjectVersion mapping ─────────────────────────────────
// Mirrors the mapping in S3ClientWrapper.listObjectVersions()

interface RawS3Version {
  Key?: string;
  VersionId?: string;
  LastModified?: Date;
  Size?: number;
  ETag?: string;
  IsLatest?: boolean;
}

function mapVersions(raw: RawS3Version[], targetKey: string) {
  return (raw)
    .filter((v) => v.Key === targetKey && v.VersionId)
    .map((v) => ({
      versionId: v.VersionId!,
      lastModified: v.LastModified ?? new Date(0),
      size: v.Size ?? 0,
      etag: (v.ETag ?? "").replace(/"/g, ""),
      isLatest: v.IsLatest ?? false,
    }))
    .sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
}

describe("version history — ObjectVersion mapping", () => {
  it("excludes versions without a VersionId", () => {
    const raw: RawS3Version[] = [
      { Key: "file.md", VersionId: "v1", LastModified: new Date(), Size: 100, ETag: '"a"', IsLatest: true },
      { Key: "file.md",                  LastModified: new Date(), Size: 100, ETag: '"b"', IsLatest: false },
    ];
    expect(mapVersions(raw, "file.md")).toHaveLength(1);
  });

  it("defaults missing Size to 0", () => {
    const raw: RawS3Version[] = [
      { Key: "file.md", VersionId: "v1", LastModified: new Date(), ETag: '"a"', IsLatest: true },
    ];
    expect(mapVersions(raw, "file.md")[0].size).toBe(0);
  });

  it("defaults missing LastModified to epoch", () => {
    const raw: RawS3Version[] = [
      { Key: "file.md", VersionId: "v1", Size: 50, ETag: '"a"', IsLatest: true },
    ];
    expect(mapVersions(raw, "file.md")[0].lastModified.getTime()).toBe(0);
  });

  it("defaults missing IsLatest to false", () => {
    const raw: RawS3Version[] = [
      { Key: "file.md", VersionId: "v1", LastModified: new Date(), Size: 50, ETag: '"a"' },
    ];
    expect(mapVersions(raw, "file.md")[0].isLatest).toBe(false);
  });

  it("handles empty ETag gracefully", () => {
    const raw: RawS3Version[] = [
      { Key: "file.md", VersionId: "v1", LastModified: new Date(), Size: 50, ETag: undefined, IsLatest: true },
    ];
    expect(mapVersions(raw, "file.md")[0].etag).toBe("");
  });
});
