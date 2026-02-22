import type { WebClient } from "@slack/web-api";
import { ChatStreamer } from "@slack/web-api";
import { logger } from "../logger.js";

const MAX_STREAM_LEN = 11_000;

const slackLogger = {
  debug: (...msg: any[]) => logger.debug(msg.join(" ")),
  info: (...msg: any[]) => logger.info(msg.join(" ")),
  warn: (...msg: any[]) => logger.warn(msg.join(" ")),
  error: (...msg: any[]) => logger.error(msg.join(" ")),
  setLevel: () => {},
  getLevel: () => "info" as any,
  setName: () => {},
};

export class SlackSender {
  private streamer: ChatStreamer | null = null;
  private accumulated = "";
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private client: WebClient,
    private channel: string,
    private threadTs: string,
    private recipientTeamId: string,
    private recipientUserId: string,
  ) {}

  async appendDelta(delta: string): Promise<void> {
    // Serialize all append operations to avoid race conditions
    this.queue = this.queue.then(() => this.doAppend(delta)).catch((e) => {
      logger.error(e, "append failed");
    });
    return this.queue;
  }

  private async doAppend(delta: string): Promise<void> {
    this.accumulated += delta;

    if (this.accumulated.length > MAX_STREAM_LEN && this.streamer) {
      await this.streamer.stop();
      this.streamer = null;
      this.accumulated = delta;
    }

    if (!this.streamer) {
      this.streamer = new ChatStreamer(this.client, slackLogger as any, {
        channel: this.channel,
        thread_ts: this.threadTs,
        recipient_team_id: this.recipientTeamId,
        recipient_user_id: this.recipientUserId,
      }, {});
    }

    await this.streamer.append({ markdown_text: delta });
  }

  async toolStatus(toolName: string, status: "running" | "done" | "failed"): Promise<void> {
    const icon = status === "running" ? "🔧" : status === "done" ? "✅" : "❌";
    await this.appendDelta(`\n${icon} _${toolName}_\n`);
  }

  async finish(): Promise<void> {
    // Wait for any pending appends to complete
    await this.queue;
    if (this.streamer) {
      await this.streamer.stop();
      this.streamer = null;
    }
  }

  async sendError(text: string): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: `⚠️ ${text}`,
    });
  }

  async postPermissionPrompt(title: string, actionId: string, _options: any[]): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: `🔐 Permission: ${title}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `🔐 *${title}*` } },
        {
          type: "actions",
          elements: [
            { type: "button", text: { type: "plain_text", text: "Trust (session)" }, action_id: `${actionId}_trust`, style: "primary" },
            { type: "button", text: { type: "plain_text", text: "Yes (once)" }, action_id: `${actionId}_approve` },
            { type: "button", text: { type: "plain_text", text: "No" }, action_id: `${actionId}_reject`, style: "danger" },
          ],
        },
      ],
    });
  }
}
