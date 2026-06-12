// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ActivityType = 'tool_use' | 'thinking' | 'writing' | 'idle' | 'error';

export interface Activity {
  type: ActivityType;
  description: string;
  startedAt: number;
  endedAt?: number;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ActivityTracker
// ---------------------------------------------------------------------------

export class ActivityTracker {
  private readonly timeline: Activity[] = [];
  private currentActivity: Activity | null = null;
  private readonly maxTimelineSize: number;

  constructor(maxTimelineSize: number = 1000) {
    this.maxTimelineSize = maxTimelineSize;
    this.setIdle();
  }

  /**
   * Feed a raw JSON line from child stdout. Parses it and extracts
   * activity information to update the current state and timeline.
   */
  feed(line: string): void {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }

    const type = parsed['type'] as string | undefined;
    if (!type) return;

    switch (type) {
      case 'assistant':
      case 'text':
      case 'content_block_delta':
        this.transition('writing', type);
        break;

      case 'thinking':
        this.transition('thinking', 'Thinking...');
        break;

      case 'tool_use':
      case 'tool_call': {
        const toolName =
          (parsed['name'] as string) ??
          (parsed['tool'] as string) ??
          'unknown tool';
        this.transition('tool_use', 'Using ' + toolName);
        break;
      }

      case 'tool_result':
      case 'tool_output':
        this.transition('thinking', 'Processing tool result');
        break;

      case 'error':
      case 'system_error': {
        const errMsg =
          (parsed['message'] as string) ??
          (parsed['error'] as string) ??
          'Unknown error';
        this.transition('error', errMsg);
        break;
      }

      case 'result':
      case 'done':
      case 'end':
        this.setIdle();
        break;

      default:
        break;
    }
  }

  /** What the child session is currently doing. */
  getCurrentActivity(): Activity | null {
    return this.currentActivity;
  }

  /** Full timeline of activities with timestamps. */
  getTimeline(): ReadonlyArray<Activity> {
    return this.timeline;
  }

  /** Elapsed time of the current activity in ms. */
  getCurrentDurationMs(): number {
    if (!this.currentActivity) return 0;
    return Date.now() - this.currentActivity.startedAt;
  }

  /** Reset the tracker — clears timeline and sets idle. */
  reset(): void {
    this.timeline.length = 0;
    this.currentActivity = null;
    this.setIdle();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private transition(
    type: ActivityType,
    description: string,
    metadata?: Record<string, unknown>,
  ): void {
    if (this.currentActivity) {
      this.currentActivity.endedAt = Date.now();
    }

    const activity: Activity = {
      type,
      description,
      startedAt: Date.now(),
      metadata,
    };

    this.currentActivity = activity;
    this.timeline.push(activity);

    while (this.timeline.length > this.maxTimelineSize) {
      this.timeline.shift();
    }
  }

  private setIdle(): void {
    if (this.currentActivity?.type === 'idle') return;
    this.transition('idle', 'Idle');
  }
}
