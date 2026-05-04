import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { validateAccessKeyId } from "../s3/client";
import { SSOSessionExpiredError, ssoRelogCommand } from "../s3/errors";
import type S3GitSyncPlugin from "../main";
import type { AuthMethod } from "../types";

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
    new Setting(containerEl).setName("S3 authentication").setHeading();

    // Security notice
    const securityBanner = containerEl.createDiv("s3sync-settings-banner");
    securityBanner.createEl("strong", { text: "Security: " });
    securityBanner.appendText(
      "Static credentials are stored in your vault's plugin data (data.json). " +
        "For production use or shared machines, prefer the AWS named profile method — " +
        "credentials remain in the OS credential store and are never written to disk by this plugin."
    );

    new Setting(containerEl)
      .setName("Authentication method")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("How this plugin authenticates to AWS S3.")
      .addDropdown((d) => {
        d.addOption("static", "Access key & secret (stored in plugin)");
        if (Platform.isDesktop) {
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          d.addOption("profile", "AWS named profile (~/.aws/credentials)");
        }
        d.setValue(this.plugin.settings.s3.authMethod)
          .onChange(async (v) => {
            this.plugin.settings.s3.authMethod = v as AuthMethod;
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
    new Setting(containerEl).setName("S3 bucket").setHeading();

    new Setting(containerEl)
      .setName("Bucket name")
      .setDesc("The S3 bucket to sync with.")
      .addText((t) =>
        t
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder("my-obsidian-vault")
          .setValue(this.plugin.settings.s3.s3BucketName)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3BucketName = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Region")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("AWS region where the bucket lives, for example: ap-southeast-1")
      .addText((t) =>
        t
          // eslint-disable-next-line obsidianmd/ui/sentence-case
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
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          .setPlaceholder("my-vault/")
          .setValue(this.plugin.settings.s3.s3Prefix)
          .onChange(async (v) => {
            this.plugin.settings.s3.s3Prefix = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setName("Force path-style URLs")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      .setDesc("Enable for MinIO and other self-hosted S3 implementations that require path-style URLs, for example: https://host/bucket/key.")
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
                `❌ AWS SSO session expired.\n\nRun in a terminal:\n  ${ssoRelogCommand(profile)}\n\nThen try again.`,
                15_000
              );
            } else {
              const msg = err instanceof Error ? err.message : String(err);
              new Notice(`❌ ${msg}`, 10_000);
            }
          } finally {
            btn.setButtonText("Test").setDisabled(false);
          }
        })
      );

    // ── Ignore patterns ───────────────────────────────────────────────────────
    new Setting(containerEl).setName("Ignore patterns").setHeading();
    containerEl.createEl("p", {
      cls: "setting-item-description",
      // eslint-disable-next-line obsidianmd/ui/sentence-case
      text: "Vault-relative paths to exclude from sync. One entry per line. Supports * and ? glob wildcards.",
    });

    const configDir = this.app.vault.configDir;
    new Setting(containerEl).addTextArea((t) => {
      t.setPlaceholder(
        `${configDir}/workspace.json\n${configDir}/workspace-mobile.json\n*.tmp`
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
      t.inputEl.addClass("s3sync-ignore-textarea");
    });

    // ── Interface ─────────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Interface").setHeading();

    new Setting(containerEl)
      .setName("Show status bar")
      .setDesc("Display last sync time and status in the bottom status bar.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.showStatusBar).onChange(async (v) => {
          this.plugin.settings.showStatusBar = v;
          await this.plugin.saveSettings();
          this.plugin.setStatusBarVisible(v);
        })
      );

    // ── Danger zone ───────────────────────────────────────────────────────────
    new Setting(containerEl).setName("Advanced").setHeading();

    new Setting(containerEl)
      .setName("Ribbon badge — poll interval")
      .setDesc(
        "How often to check S3 for remote changes and show a count badge on the ribbon icon. " +
          "Set to 0 to disable. Each poll is one S3 ListObjects call (~$0.01/month at 5-minute intervals)."
      )
      .addSlider((s) =>
        s
          .setLimits(0, 60, 5)
          .setValue(this.plugin.settings.badgePollIntervalMin)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.badgePollIntervalMin = v;
            await this.plugin.saveSettings();
            this.plugin.restartBadgePoll();
          })
      );

    new Setting(containerEl)
      .setName("Export S3 backup")
      .setDesc(
        "Download all files currently in the S3 bucket as a single ZIP archive. " +
          "Useful as a point-in-time backup before a bulk operation."
      )
      .addButton((btn) =>
        btn.setButtonText("Export backup").onClick(() => {
          this.plugin.exportBackup();
        })
      );

    new Setting(containerEl)
      .setName("Export settings")
      .setDesc(
        "Download a JSON file with all settings except credentials. " +
          "Use this to bootstrap the plugin on another device."
      )
      .addButton((btn) =>
        btn.setButtonText("Export").onClick(() => {
          this.plugin.exportSettings();
        })
      );

    new Setting(containerEl)
      .setName("Import settings")
      .setDesc(
        "Load settings from a previously exported JSON file. " +
          "Your credentials on this device will not be overwritten."
      )
      .addButton((btn) =>
        btn.setButtonText("Import").onClick(() => {
          this.plugin.importSettings();
        })
      );

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
            activeWindow.setTimeout(() => {
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
    const configDir = this.app.vault.configDir;
    const note = container.createDiv("s3sync-settings-auth-note");
    note.createEl("p", {
      text:
        `Credentials are saved in ${configDir}/plugins/s3-git-sync/data.json. ` +
        "A .gitignore entry for data.json is automatically created to prevent accidental commits. " +
        "Avoid this method on shared or multi-user machines.",
    });

    new Setting(container)
      .setName("Access key ID")
      // eslint-disable-next-line obsidianmd/ui/sentence-case
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
      .setName("Secret access key")
      .addText((t) => {
        // eslint-disable-next-line obsidianmd/ui/sentence-case
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
          // eslint-disable-next-line obsidianmd/ui/sentence-case
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
