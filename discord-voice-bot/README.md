# Discord Voice Chat Bot

A voice-enabled Discord bot that can:
- Listen to voice chat (Speech-to-Text)
- Process what was said with AI
- Respond with voice (Text-to-Speech)

## Features

- 🎤 **Speech-to-Text**: Uses OpenAI Whisper to transcribe voice
- 🗣️ **Text-to-Speech**: Uses OpenAI TTS to speak responses
- 🤖 **AI Responses**: Processes speech and generates intelligent responses
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

2. **OpenAI API Key**
   - Get an API key from [OpenAI](https://platform.openai.com/)
   - Need access to:
     - Whisper API (speech-to-text)
     - TTS API (text-to-speech)
     - GPT-4 API (AI responses)

3. **System Dependencies**
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

Create a `.env` file:

```env
DISCORD_BOT_TOKEN=your_discord_bot_token_here
OPENAI_API_KEY=your_openai_api_key_here
```

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
4. **Converted to WAV** using ffmpeg
5. **Transcribed** using OpenAI Whisper
6. **AI generates response** using GPT-4
7. **Response converted to speech** using OpenAI TTS
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
       │ Opus → PCM → WAV
       ▼
┌─────────────────┐
│  OpenAI Whisper │
│  (Speech-to-Text)│
└──────┬──────────┘
       │ Transcript
       ▼
┌─────────────────┐
│     GPT-4       │
│  (AI Response)  │
└──────┬──────────┘
       │ Response Text
       ▼
┌─────────────────┐
│   OpenAI TTS    │
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

Using OpenAI APIs:
- **Whisper**: $0.006 per minute of audio
- **TTS**: $15 per 1M characters
- **GPT-4**: ~$0.03 per 1k tokens

Typical conversation:
- 10 second voice message: ~$0.001
- AI response generation: ~$0.003
- TTS response: ~$0.0015
- **Total per exchange**: ~$0.006

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

1. **Google Cloud**
   - Speech-to-Text API
   - Text-to-Speech API
   - Usually cheaper than OpenAI for high volume

2. **Azure Cognitive Services**
   - Speech Services
   - Good quality, competitive pricing

3. **Assembly AI**
   - Real-time transcription
   - Good for streaming audio

## Customization

### Change AI Model

Edit `src/index.ts`:

```typescript
// Use Claude instead of GPT-4
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

async function getAIResponse(userMessage: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: 'claude-3-5-sonnet-20241022',
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

Available OpenAI voices: `alloy`, `echo`, `fable`, `onyx`, `nova`, `shimmer`

```typescript
const mp3 = await openai.audio.speech.create({
  model: 'tts-1',
  voice: 'nova', // Change here
  input: text,
});
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
- Verify OpenAI API key is valid

### Audio quality issues

- Increase bitrate in voice channel settings
- Adjust sample rate in PCM conversion
- Try different TTS voices

### High latency

- Use `tts-1` (faster) instead of `tts-1-hd`
- Reduce GPT-4 max_tokens
- Consider caching common responses

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
- [OpenAI Whisper API](https://platform.openai.com/docs/guides/speech-to-text)
- [OpenAI TTS API](https://platform.openai.com/docs/guides/text-to-speech)
- [DiscordSpeechBot](https://github.com/inevolin/DiscordSpeechBot)
- [discord-speech-recognition](https://github.com/Rei-x/discord-speech-recognition)
- [Gladia Voice-to-Text Guide](https://www.gladia.io/blog/how-to-build-a-voice-to-text-discord-bot-with-gladia-real-time-transcription-api)
