# Claude Web Features

## ✅ Implemented

### Core Functionality
- **Mobile-First Design** - Optimized for Google Pixel Fold and mobile devices
- **Session Management** - Create, switch between, and manage multiple conversation sessions
- **Sidebar Navigation** - Collapsible sidebar with session list (hamburger menu on mobile)
- **MCP Configuration** - Configure MCP servers through the UI with JSON editor
- **Auto-Approve Tools** - No permission gates, all tools automatically approved
- **Session Resumption** - Conversations persist across page reloads

### UI/UX
- **Markdown Rendering** ✨ - Rich text formatting for assistant responses using marked.js
  - Code blocks with syntax highlighting
  - Lists, headers, blockquotes
  - Tables, links
  - Inline code formatting
- **Compact Tool Display** - Tool calls minimized by default, expand to see details
- **Responsive Layout** - Adapts to mobile (<768px), tablet (≥768px), and desktop (≥1024px)
- **Real-Time Streaming** - WebSocket connection for live message updates
- **Dark Theme** - Clean, easy-on-the-eyes dark interface

### Technical
- **WebSocket Communication** - Real-time bidirectional communication
- **Persistent Storage** - Sessions and MCP config saved to disk
- **SDK Event Streaming** - Full support for all Claude Agent SDK event types
- **Interrupt Support** - Stop long-running queries with pause button

## 🚧 Considered (Punted for Now)

### Voice Input
**Status:** Punted - Not a priority for initial version

**Why:**
- Adds complexity to mobile implementation
- Browser API compatibility varies across devices
- Can be added later as enhancement

**Future Approach:**
- Use Web Speech API for speech-to-text
- Add microphone button next to send button
- Stream audio to backend for processing
- Fallback to text input if not supported

### File Upload
**Status:** Deferred - Would be useful but not critical

**Implementation Plan:**
- Add file input button to message area
- Support common formats (images, documents, code files)
- Base64 encode for transmission
- Preview before sending
- Show file attachments in message thread

### Conversation Search
**Status:** Not needed yet - Can add when conversation history grows

**Future Implementation:**
- Add search icon to header
- Search across all sessions
- Highlight matches in conversation
- Filter by date, session, or content type

## 🎯 Notifications via Discord

**Status:** Implemented via MCP tool

**How it works:**
- Claude can use Discord MCP to send notifications
- Tag you in #claude-chat channel
- Include Tailscale links for easy mobile access
- Can be triggered on:
  - Long-running queries completing
  - Errors or important events
  - Self-configuration completions

**Usage:**
Claude can say: "I'll notify you when this is done" and then use the Discord MCP to send you a message with a link.

## 📝 Usage Examples

### Basic Usage
```
1. Open http://<tailscale-ip>:8080 on your phone
2. Type a message to Claude
3. Messages appear in real-time
4. Tool calls show minimized - tap to expand
```

### MCP Self-Configuration
```
You: "Create an MCP server that fetches weather data"

Claude will:
1. Write the MCP server code
2. Save to disk
3. Update MCP configuration
4. Notify you it's ready
5. (You can restart to apply changes)
```

### Multiple Sessions
```
1. Tap ☰ menu
2. Tap "+ New Session"
3. Switch between sessions
4. Each session has independent context
```

## 🔮 Future Enhancements

**High Priority:**
- File upload capability
- Better error handling and retry logic
- Session export/import
- Conversation branching

**Medium Priority:**
- Voice input for mobile
- Conversation search
- Custom themes
- Keyboard shortcuts

**Low Priority:**
- Multi-user support
- Session sharing
- Analytics dashboard
- Plugin system

## 🐛 Known Issues

1. **Send button off-screen**: On some smaller screens, the send button might be cut off. Use Enter key as workaround.
2. **WebSocket reconnection**: If connection drops, refresh the page to reconnect.
3. **Large tool outputs**: Very large tool outputs might slow down the UI. Consider pagination.

## 📱 Mobile Testing Checklist

- [x] Loads on mobile browser
- [x] Sidebar opens/closes smoothly
- [x] Input field auto-focuses
- [x] Enter key sends messages
- [x] Messages display correctly
- [x] Tool calls expand/collapse
- [x] MCP config modal opens
- [x] Works in portrait mode
- [ ] Works in landscape/unfolded mode (needs testing on Pixel Fold)
- [ ] Handles interrupts properly
- [ ] Session switching works smoothly

## 🎨 Customization

The codebase is designed for easy customization:

**Colors**: Edit CSS variables in `styles.css`:
```css
:root {
  --bg-primary: #0f0f0f;
  --accent-color: #6366f1;
  /* etc. */
}
```

**Layout**: Modify breakpoints in `styles.css`:
```css
@media (min-width: 768px) { /* tablet */ }
@media (min-width: 1024px) { /* desktop */ }
```

**Features**: Server-side in `server.ts`, client-side in `app.js`
