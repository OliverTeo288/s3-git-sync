import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { SSOSessionExpiredError, validateAccessKeyId } from "./s3client";
import type S3GitSyncPlugin from "./main";

export class S3GitSyncSettingTab extends PluginSettingTab {
  plugin: S3GitSyncPlugin;

  constructor(app: App, plugin: S3GitSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Authentication method ─────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "S3 Authentication" });

    // Security notice
    const securityBanner = containerEl.createDiv("s3sync-settings-banner");
    securityBanner.createEl("strong", { text: "Security: " });
    securityBanner.appendText(
      "Static credentials are stored in your vault's plugin data (data.json). " +
        "For production use or shared machines, prefer the AWS Named Profile method — " +
        "credentials remain in the OS credential store and are never written to disk by this plugin."
    );

    let authMethodSetting: Setting;

    new Setting(containerEl)
      .setName("Authentication method")
      .setDesc("How this plugin authenticates to AWS S3.")
      .addDropdown((d) => {
        d.addOption("static", "Access Key & Secret (stored in plugin)");
        if (Platform.isDesktop) {
          d.addOption("profile", "AWS Named Profile (~/.aws/credentials)");
        }
        d.setValue(this.plugin.settings.s3.authMethod)
          .onChange(async (v: any) => {
            this.plugin.settings.s3.authMethod = v;
            await this.plugin.saveSettings();
            // Re-render to show/hide the relevant credential fields
            this.display();
          });
      });

    const authMethod = this.plugin.settings.s3.authMethod;

    if (authMethod === "static") {
      this.renderStaticCredentials(containerEl);
    } else {
      this.renderProfileCredentials(containerEl);
    }

    // ── Common S3 settings ────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "S3 Bucket" });

    new Setting(containerEl)
      .setName("Bucket name")
      .setDesc("The S3 bucket to sync with.")
      .addText((t) =>
        t
          .setPlaceholder("my-obsidian-vault")
          .setValue(this.plugin.settings.s3.s3BucketName)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3BucketName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Region")
      .setDesc("AWS region where the bucket lives, e.g. ap-southeast-1")
      .addText((t) =>
        t
          .setPlaceholder("us-east-1")
          .setValue(this.plugin.settings.s3.s3Region)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3Region = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Endpoint (optional)")
      .setDesc(
        "Custom S3-compatible endpoint. Leave blank for AWS S3. " +
          "Example: https://s3.ap-southeast-1.amazonaws.com or a MinIO URL."
      )
      .addText((t) => {
        t.setPlaceholder("https://s3.amazonaws.com")
          .setValue(this.plugin.settings.s3.s3Endpoint)
          .onChange(async (v) => {
            const val = v.trim();
            if (val && val.startsWith("http://")) {
              t.inputEl.classList.add("s3sync-input-warning");
              t.inputEl.title = "⚠ Plain HTTP — traffic will not be encrypted in transit.";
            } else {
              t.inputEl.classList.remove("s3sync-input-warning");
              t.inputEl.title = "";
            }
            this.plugin.settings.s3.s3Endpoint = val;
            await this.plugin.saveSettings();
          });
        // Apply warning class on initial load if already set to HTTP
        if (this.plugin.settings.s3.s3Endpoint.startsWith("http://")) {
          t.inputEl.classList.add("s3sync-input-warning");
          t.inputEl.title = "⚠ Plain HTTP — traffic will not be encrypted in transit.";
        }
      });

    new Setting(containerEl)
      .setName("Remote prefix")
      .setDesc(
        "Optional key prefix inside the bucket — acts like a branch. " +
          "Multiple vaults can share one bucket by using different prefixes. " +
          'Example: "personal-vault/".'
      )
      .addText((t) =>
        t
          .setPlaceholder("my-vault/")
          .setValue(this.plugin.settings.s3.s3Prefix)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3Prefix = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Force path-style URLs")
      .setDesc("Enable for MinIO and other self-hosted S3 implementations that require path-style URLs (e.g. https://host/bucket/key).")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.s3.forcePathStyle).onChange(async (v) => {
          this.plugin.settings.s3.forcePathStyle = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Verify the current settings can reach S3.")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          btn.setButtonText("Testing…").setDisabled(true);
          try {
            await this.plugin.getS3Client().testConnection();
            new Notice("✅ Connection successful!");
          } catch (err: unknown) {
            if (err instanceof SSOSessionExpiredError) {
              const profile = this.plugin.settings.s3.s3ProfileName || "default";
              new Notice(
                `❌ AWS SSO session expired.\n\nRun in a terminal:\n  aws sso login --profile ${profile}\n\nThen try again.`,
                15_000
              );
            } else {
              const msg = (err as Record<string, unknown>)?.["message"] as string | undefined ?? String(err);
              new Notice(`❌ ${msg}`, 10_000);
            }
          } finally {
            btn.setButtonText("Test").setDisabled(false);
          }
        })
      );

    // ── Ignore patterns ───────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Ignore Patterns" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: "Vault-relative paths to exclude from sync. One entry per line. Supports * and ? wildcards.",
    });

    new Setting(containerEl).addTextArea((t) => {
      t.setPlaceholder(
        ".obsidian/workspace.json\n.obsidian/workspace-mobile.json\n*.tmp"
      )
        .setValue(this.plugin.settings.ignorePatterns.join("\n"))
        .onChange(async (v) => {
          this.plugin.settings.ignorePatterns = v
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
      t.inputEl.rows = 6;
      t.inputEl.style.width = "100%";
    });

    // ── Interface ─────────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Interface" });

    new Setting(containerEl)
      .setName("Show status bar")
      .setDesc("Display last sync time and status in the bottom status bar.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showStatusBar).onChange(async (v) => {
          this.plugin.settings.showStatusBar = v;
          await this.plugin.saveSettings();
        })
      );

    // ── Danger zone ───────────────────────────────────────────────────────────
    containerEl.createEl("h2", { text: "Advanced" });

    new Setting(containerEl)
      .setName("Reset sync state")
      .setDesc(
        "Clears the local record of which files have been synced and when. " +
          "On the next sync everything will appear as new on both sides — existing files " +
          "will show as conflicts if they exist in both places. This cannot be undone."
      )
      .addButton((btn) => {
        let confirmPending = false;
        btn.setButtonText("Reset").setWarning().onClick(async () => {
          if (!confirmPending) {
            confirmPending = true;
            btn.setButtonText("Click again to confirm");
            setTimeout(() => {
              if (confirmPending) {
                confirmPending = false;
                btn.setButtonText("Reset");
              }
            }, 4_000);
            return;
          }
          confirmPending = false;
          btn.setButtonText("Reset");
          await this.plugin.db.clearAllSyncRecords();
          new Notice("Sync state cleared. Next sync will treat everything as a fresh start.");
        });
      });
  }

  // ─── Auth-method panels ───────────────────────────────────────────────────

  private renderStaticCredentials(container: HTMLElement) {
    const note = container.createDiv("s3sync-settings-auth-note");
    note.createEl("p", {
      text:
        "Credentials are saved in .obsidian/plugins/s3-git-sync/data.json. " +
        "A .gitignore entry for data.json is automatically created to prevent accidental commits. " +
        "Avoid this method on shared or multi-user machines.",
    });

    new Setting(container)
      .setName("Access Key ID")
      .setDesc("Starts with AKIA (long-term) or ASIA (temporary session).")
      .addText((t) => {
        t.setPlaceholder("AKIAIOSFODNN7EXAMPLE")
          .setValue(this.plugin.settings.s3.s3AccessKeyID)
          .onChange(async (v) => {
            const key = v.trim();
            const err = validateAccessKeyId(key);
            t.inputEl.title = err ?? "";
            t.inputEl.classList.toggle("s3sync-input-error", !!err && key.length > 0);
            this.plugin.settings.s3.s3AccessKeyID = key;
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
      });

    new Setting(container)
      .setName("Secret Access Key")
      .addText((t) => {
        t.setPlaceholder("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY")
          .setValue(this.plugin.settings.s3.s3SecretAccessKey)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3SecretAccessKey = v.trim();
            await this.plugin.saveSettings();
          });
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
      });
  }

  private renderProfileCredentials(container: HTMLElement) {
    const note = container.createDiv("s3sync-settings-auth-note s3sync-settings-auth-note--good");
    note.createEl("p", {
      text:
        "Uses the AWS credential chain: reads the named profile from " +
        "~/.aws/credentials and ~/.aws/config. " +
        "No credentials are stored by this plugin. " +
        "Supports IAM Identity Center (SSO), assume-role, MFA, and all standard AWS auth flows. " +
        "Run `aws sso login --profile <name>` before syncing if using SSO.",
    });

    if (!Platform.isDesktop) {
      container.createEl("p", {
        cls: "s3sync-settings-mobile-warn",
        text: "⚠ Named profiles are not available on mobile. Switch to static credentials.",
      });
      return;
    }

    new Setting(container)
      .setName("Profile name")
      .setDesc(
        'The profile name from ~/.aws/credentials (e.g. "default", "work", "obsidian-sync"). ' +
          "Leave blank to use the default profile."
      )
      .addText((t) =>
        t
          .setPlaceholder("default")
          .setValue(this.plugin.settings.s3.s3ProfileName)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3ProfileName = v.trim() || "default";
            await this.plugin.saveSettings();
          })
      );

    container.createEl("p", {
      cls: "setting-item-description",
      text:
        'Tip: Run "aws configure list-profiles" in a terminal to see available profiles. ' +
        'If using SSO, run "aws sso login --profile <name>" before syncing.',
    });
  }
}
