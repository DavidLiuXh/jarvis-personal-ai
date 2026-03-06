# macOS Scheduler & Automation Skill

This skill provides a robust, native-first strategy for scheduling tasks and reminders on macOS. It handles one-time events and complex recurring jobs.

## 🎯 Prioritization Strategy

1. **System Native (Primary)**: Always try to use "Reminders" or "Calendar" first.
2. **Daemon Services (Secondary)**: For recurring tasks, use `launchctl` (launchd).
3. **Shell Fallback (Tertiary)**: Use background shell processes only if native options are strictly impossible.

---

## 🛠️ Implementation Patterns

### 1. One-time Reminders (Stable)
Use `osascript` to add to the native Reminders app.
```applescript
tell application "Reminders"
    make new reminder in default list with properties {name:"JARVIS: " & "USER_TASK", remind me date:date "ISO_TIMESTAMP"}
end tell
```

### 2. Recurring Tasks (via launchd)
For tasks that repeat (e.g., "every morning at 9", "every hour"), create a User Agent Plist in `~/Library/LaunchAgents/`.

**Workflow**:
1. Generate a plist file (e.g., `com.jarvis.task.plist`).
2. Use `StartCalendarInterval` for specific times or `StartInterval` for every X seconds.
3. Call `launchctl load` to activate it.

**Example Plist snippet for "Every hour"**:
```xml
<key>StartInterval</key>
<integer>3600</integer>
<key>ProgramArguments</key>
<array>
    <string>/usr/bin/osascript</string>
    <string>-e</string>
    <string>display notification "Time to stretch!" with title "Jarvis"</string>
</array>
```

### 3. Calendar Events
For specific appointments or block-time tasks.
```applescript
tell application "Calendar"
    tell calendar "Work"
        make new event with properties {summary:"JARVIS: TASK", start date:date "...", end date:date "..."}
    end tell
end tell
```

---

## 📝 Example Usage

**User**: "Remind me to drink water every hour."
**Jarvis Action**:
1. Recognizes this is a **recurring task**.
2. Creates a `launchd` plist in `~/Library/LaunchAgents/com.jarvis.water.plist`.
3. Sets `StartInterval` to `3600`.
4. Runs `launchctl load`.
5. Confirm: "I've registered a system-level background job. I'll remind you to drink water every hour."

**User**: "Alert me at 11:59 today."
**Jarvis Action**: 
1. Recognizes this is a **one-time reminder**.
2. Uses **Reminders app** pattern via osascript.
