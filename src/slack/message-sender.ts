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
  private lastMessageTs: string | null = null;

  constructor(
    private client: WebClient,
    private channel: string,
    private threadTs: string,
    private recipientTeamId: string,
    private recipientUserId: string,
  ) {}

  private getMessageTs(): string | null {
    return (this.streamer as any)?.streamTs ?? this.lastMessageTs;
  }

  private async react(name: string, remove = false): Promise<void> {
    const ts = this.getMessageTs();
    if (!ts) return;
    try {
      if (remove) {
        await this.client.reactions.remove({ channel: this.channel, timestamp: ts, name });
      } else {
        await this.client.reactions.add({ channel: this.channel, timestamp: ts, name });
      }
    } catch {}
  }

  async markThinking(): Promise<void> { await this.react("hourglass_flowing_sand"); }
  async clearThinking(): Promise<void> { await this.react("hourglass_flowing_sand", true); }
  async markDone(): Promise<void> { await this.react("white_check_mark"); }

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
      this.lastMessageTs = (this.streamer as any).streamTs ?? null;
      await this.streamer.stop();
      await this.clearThinking();
      this.streamer = null;
      this.accumulated = delta;
    }

    const isNew = !this.streamer;
    if (!this.streamer) {
      this.streamer = new ChatStreamer(this.client, slackLogger as any, {
        channel: this.channel,
        thread_ts: this.threadTs,
        recipient_team_id: this.recipientTeamId,
        recipient_user_id: this.recipientUserId,
      }, {});
    }

    try {
      await this.streamer.append({ markdown_text: delta });
    } catch (e: any) {
      if (e?.data?.error === "message_not_in_streaming_state") {
        // Stream timed out — start a new message
        this.lastMessageTs = (this.streamer as any).streamTs ?? null;
        this.streamer = null;
        this.accumulated = delta;
        this.streamer = new ChatStreamer(this.client, slackLogger as any, {
          channel: this.channel,
          thread_ts: this.threadTs,
          recipient_team_id: this.recipientTeamId,
          recipient_user_id: this.recipientUserId,
        }, {});
        await this.streamer.append({ markdown_text: delta });
      } else {
        throw e;
      }
    }

    if (isNew) {
      await this.markThinking();
    }
  }

  async finish(): Promise<void> {
    await this.queue;
    if (this.streamer) {
      this.lastMessageTs = (this.streamer as any).streamTs ?? null;
      await this.streamer.stop();
      this.streamer = null;
    }
    await this.clearThinking();
    await this.markDone();
  }

  async sendError(text: string): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.channel,
      thread_ts: this.threadTs,
      text: `⚠️ ${text}`,
    });
  }
}
