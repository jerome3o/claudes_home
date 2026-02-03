# Discord Voice Chat Bot

A voice-enabled Discord bot that can:
- Listen to voice chat (Speech-to-Text)
- Process what was said with AI
- Respond with voice (Text-to-Speech)

## Features

- 🎤 **Speech-to-Text**: Uses Google Cloud Speech-to-Text to transcribe voice
- 🗣️ **Text-to-Speech**: Uses Google Cloud Text-to-Speech to speak responses
- 🤖 **AI Responses**: Uses Claude 3.5 Sonnet via Anthropic API for intelligent responses
- 🎵 **Voice Channel Management**: Join/leave voice channels via commands

## Prerequisites

1. **Discord Bot Token**
   - Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
   - Enable these intents:
     - Guilds
     - Guild Messages
     - Guild Voice States
     - Message Content
   - Add bot to your server with Voice permissions

2. **Google Cloud Project & Service Account**
   - Create a project at [Google Cloud Console](https://console.cloud.google.com/)
   - Enable these APIs:
     - Cloud Speech-to-Text API
     - Cloud Text-to-Speech API
   - Create a service account and download the JSON key file

3. **Anthropic API Key**
   - Get an API key from [Anthropic](https://console.anthropic.com/)
   - Need access to Claude 3.5 Sonnet

4. **System Dependencies**
   - Node.js 18+
   - ffmpeg (for audio conversion)

## Installation

```bash
# Install dependencies
npm install

# Install ffmpeg (if not already installed)
# Ubuntu/Debian:
sudo apt-get install ffmpeg

# macOS:
brew install ffmpeg
```

## Configuration

1. Create a `.env` file:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token_here
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account-key.json
ANTHROPIC_API_KEY=your_anthropic_api_key_here
```

2. Place your Google Cloud service account JSON key file in a secure location and update the path in `.env`

## Building

```bash
npm run build
```

## Running

```bash
# Production
npm start

# Development (with auto-reload)
npm run dev
```

## Commands

### `!join`
Bot joins your current voice channel and starts listening.

```
User: !join
Bot: Joined General! Start speaking and I'll respond.
```

### `!leave`
Bot leaves the voice channel.

```
User: !leave
Bot: Left the voice channel.
```

### `!say <text>`
Bot speaks the provided text in the voice channel.

```
User: !say Hello everyone!
Bot: ✅ Spoken!
```

## How It Works

### Voice Conversation Flow

1. **User speaks** in voice channel
2. **Bot detects speech** (after 1 second of silence)
3. **Audio is recorded** as PCM
4. **Converted to FLAC** using ffmpeg
5. **Transcribed** using Google Cloud Speech-to-Text
6. **AI generates response** using Claude 3.5 Sonnet
7. **Response converted to speech** using Google Cloud Text-to-Speech
8. **Bot speaks** the response in voice channel

### Architecture

```
┌─────────────┐
│   User      │
│  Speaking   │
└──────┬──────┘
       │ Audio Stream
       ▼
┌─────────────────┐
│  Discord Bot    │
│  Voice Receiver │
└──────┬──────────┘
       │ Opus → PCM → FLAC
       ▼
┌─────────────────┐
│ Google Cloud STT│
│  (Speech-to-Text)│
└──────┬──────────┘
       │ Transcript
       ▼
┌─────────────────┐
│  Claude 3.5     │
│  (AI Response)  │
└──────┬──────────┘
       │ Response Text
       ▼
┌─────────────────┐
│ Google Cloud TTS│
│ (Text-to-Speech)│
└──────┬──────────┘
       │ Audio MP3
       ▼
┌─────────────────┐
│  Discord Bot    │
│   Voice Player  │
└─────────────────┘
       │
       ▼
   User Hears Response
```

## API Costs

Using Google Cloud and Anthropic APIs:
- **Google Cloud STT**: $0.006 per 15 seconds of audio ($0.024/minute)
- **Google Cloud TTS**: $16 per 1M characters (Neural2 voices)
- **Claude 3.5 Sonnet**: $3 per 1M input tokens, $15 per 1M output tokens

Typical conversation:
- 10 second voice message (STT): ~$0.004
- AI response generation (Claude): ~$0.001
- TTS response: ~$0.002
- **Total per exchange**: ~$0.007

## Alternative STT/TTS Options

### Free/Open Source

1. **Vosk** (offline STT)
   ```bash
   npm install vosk
   ```

2. **Piper TTS** (offline TTS)
   ```bash
   npm install @rhasspy/piper
   ```

3. **Coqui TTS** (offline TTS)
   ```bash
   npm install coqui-tts
   ```

### Cloud Services

1. **OpenAI**
   - Whisper API (speech-to-text)
   - TTS API (text-to-speech)
   - Good quality, simple API

2. **Azure Cognitive Services**
   - Speech Services
   - Good quality, competitive pricing

3. **Assembly AI**
   - Real-time transcription
   - Good for streaming audio

## Customization

### Change AI Model

Edit `src/index.ts` to use a different Claude model:

```typescript
async function getAIResponse(userMessage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-3-opus-20240229', // or claude-3-sonnet-20240229
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: userMessage,
    }],
  });

  return response.content[0].text;
}
```

### Change TTS Voice

Available Google Cloud voices can be found [here](https://cloud.google.com/text-to-speech/docs/voices). Popular options:

```typescript
const request = {
  input: { text },
  voice: {
    languageCode: 'en-US',
    name: 'en-US-Neural2-A', // Male voice
    // or 'en-US-Neural2-C' for female
    // or 'en-GB-Neural2-B' for British male
    ssmlGender: 'MALE' as const,
  },
  audioConfig: {
    audioEncoding: 'MP3' as const,
  },
};
```

### Adjust Silence Detection

```typescript
const audioStream = receiver.subscribe(userId, {
  end: {
    behavior: EndBehaviorType.AfterSilence,
    duration: 2000, // Change to 2 seconds
  },
});
```

## Troubleshooting

### Bot can't hear anyone

- Make sure bot has "Use Voice Activity" permission
- Check that `selfDeaf: false` in `joinVoiceChannel`
- Verify Google Cloud credentials are valid and APIs are enabled
- Check that `GOOGLE_APPLICATION_CREDENTIALS` path is correct

### Audio quality issues

- Increase bitrate in voice channel settings
- Adjust sample rate in PCM conversion
- Try different TTS voices

### High latency

- Use standard voices instead of Neural2 voices for faster TTS
- Reduce Claude max_tokens
- Consider caching common responses
- Use streaming for longer responses

## Project Structure

```
discord-voice-bot/
├── src/
│   └── index.ts          # Main bot code
├── build/                # Compiled JavaScript
├── package.json
├── tsconfig.json
├── .env                  # Environment variables (git-ignored)
└── README.md
```

## Security

- Never commit `.env` file
- Keep API keys secret
- Use environment variables for all credentials
- Consider rate limiting for production use

## Contributing

Feel free to submit issues and pull requests!

## License

MIT

## Sources & References

- [Discord.js Voice Documentation](https://discord.js.org/docs/packages/voice/stable)
- [Google Cloud Speech-to-Text API](https://cloud.google.com/speech-to-text/docs)
- [Google Cloud Text-to-Speech API](https://cloud.google.com/text-to-speech/docs)
- [Anthropic Claude API](https://docs.anthropic.com/claude/reference/getting-started-with-the-api)
- [DiscordSpeechBot](https://github.com/inevolin/DiscordSpeechBot)
- [discord-speech-recognition](https://github.com/Rei-x/discord-speech-recognition)
