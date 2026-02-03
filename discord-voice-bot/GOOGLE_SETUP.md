# Google Cloud Setup Guide

This bot uses Google Cloud Speech-to-Text and Text-to-Speech APIs. Follow these steps to set up your Google Cloud project and credentials.

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Enter a project name (e.g., "discord-voice-bot")
4. Click "Create"

## Step 2: Enable Required APIs

1. In the Google Cloud Console, go to **APIs & Services** → **Library**
2. Search for and enable the following APIs:
   - **Cloud Speech-to-Text API**
   - **Cloud Text-to-Speech API**

Direct links:
- https://console.cloud.google.com/apis/library/speech.googleapis.com
- https://console.cloud.google.com/apis/library/texttospeech.googleapis.com

## Step 3: Create a Service Account

1. Go to **IAM & Admin** → **Service Accounts**
2. Click **Create Service Account**
3. Enter a name (e.g., "discord-bot")
4. Click **Create and Continue**
5. Grant these roles:
   - **Cloud Speech Client**
   - **Cloud Text-to-Speech API Client**
6. Click **Continue** → **Done**

## Step 4: Create and Download Service Account Key

1. Click on your newly created service account
2. Go to the **Keys** tab
3. Click **Add Key** → **Create new key**
4. Select **JSON** format
5. Click **Create**
6. The JSON key file will be downloaded to your computer

## Step 5: Configure Your Bot

1. Move the downloaded JSON key file to a secure location on your server:
   ```bash
   mkdir -p ~/.gcloud
   mv ~/Downloads/your-project-xxxxx.json ~/.gcloud/discord-bot-credentials.json
   chmod 600 ~/.gcloud/discord-bot-credentials.json
   ```

2. Update your `.env` file:
   ```env
   DISCORD_BOT_TOKEN=your_discord_bot_token_here
   GOOGLE_APPLICATION_CREDENTIALS=/home/youruser/.gcloud/discord-bot-credentials.json
   ANTHROPIC_API_KEY=your_anthropic_api_key_here
   ```

3. Install dependencies:
   ```bash
   npm install
   ```

4. Build and run:
   ```bash
   npm run build
   npm start
   ```

## Pricing

### Google Cloud Free Tier

Both APIs offer generous free tiers:

- **Speech-to-Text**: 60 minutes free per month
- **Text-to-Speech**: 1 million characters free per month (Standard voices) or 4 million characters (Neural2 voices)

### Paid Pricing (after free tier)

- **Speech-to-Text**: $0.006 per 15 seconds ($0.024/minute)
- **Text-to-Speech**:
  - Standard voices: $4 per 1M characters
  - WaveNet voices: $16 per 1M characters
  - Neural2 voices: $16 per 1M characters

### Typical Usage

For a moderately active Discord bot:
- 100 voice interactions per day
- Average 10 seconds of input speech
- Average 50 characters of TTS output

Monthly costs:
- STT: 100 × 30 × 10s = 30,000s = 500 minutes = ~$12/month
- TTS: 100 × 30 × 50 = 150,000 chars = **FREE** (under 1M limit)
- **Total: ~$12/month** (or **FREE** if under 60 minutes of STT per month)

## Troubleshooting

### "Could not load the default credentials"

Make sure:
1. `GOOGLE_APPLICATION_CREDENTIALS` in `.env` points to the correct JSON file path
2. The JSON file has correct permissions (`chmod 600`)
3. The path is absolute, not relative

### "API has not been used in project"

1. Go to Google Cloud Console
2. Navigate to **APIs & Services** → **Library**
3. Search for the API and click **Enable**

### "Permission denied" errors

1. Go to **IAM & Admin** → **Service Accounts**
2. Click on your service account
3. Check that it has the required roles:
   - Cloud Speech Client
   - Cloud Text-to-Speech API Client

### Testing Your Setup

You can test your Google Cloud credentials with this command:

```bash
node -e "
const speech = require('@google-cloud/speech');
const tts = require('@google-cloud/text-to-speech');
console.log('STT Client:', new speech.SpeechClient().constructor.name);
console.log('TTS Client:', new tts.TextToSpeechClient().constructor.name);
console.log('✅ Google Cloud clients initialized successfully!');
"
```

## Security Best Practices

1. **Never commit your JSON key file to git** (it's already in `.gitignore`)
2. **Use environment variables** for the credentials path
3. **Restrict key permissions**: Only grant the minimum required roles
4. **Rotate keys regularly**: Create new keys every 90 days
5. **Delete unused keys**: Remove old keys from the service account

## Alternative: Using Application Default Credentials

If running on Google Cloud (GCE, GKE, Cloud Run), you can use Application Default Credentials instead of a service account key file:

1. Attach a service account to your compute instance
2. Remove `GOOGLE_APPLICATION_CREDENTIALS` from `.env`
3. The Google Cloud client libraries will automatically use the instance's service account

This is more secure as there's no key file to manage.

## Monitoring Usage

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Navigate to **APIs & Services** → **Dashboard**
3. View usage charts for Speech-to-Text and Text-to-Speech APIs
4. Set up budget alerts to avoid unexpected charges

## References

- [Google Cloud Speech-to-Text Documentation](https://cloud.google.com/speech-to-text/docs)
- [Google Cloud Text-to-Speech Documentation](https://cloud.google.com/text-to-speech/docs)
- [Service Account Authentication](https://cloud.google.com/docs/authentication/getting-started)
- [Available TTS Voices](https://cloud.google.com/text-to-speech/docs/voices)
