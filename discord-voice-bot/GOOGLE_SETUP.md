# Google Cloud Setup for Discord Voice Bot

This bot uses Google Cloud Speech-to-Text and Text-to-Speech APIs. Follow these steps to set up your Google Cloud credentials:

## 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Note your project ID

## 2. Enable Required APIs

Enable these APIs in your project:
- **Cloud Speech-to-Text API** - for transcribing voice to text
- **Cloud Text-to-Speech API** - for generating speech from text

You can enable them here:
- https://console.cloud.google.com/apis/library/speech.googleapis.com
- https://console.cloud.google.com/apis/library/texttospeech.googleapis.com

## 3. Create a Service Account

1. Go to [Service Accounts](https://console.cloud.google.com/iam-admin/serviceaccounts)
2. Click "Create Service Account"
3. Name it something like "discord-voice-bot"
4. Grant these roles:
   - **Cloud Speech Client**
   - **Cloud Text-to-Speech Client**
5. Click "Done"

## 4. Create and Download Key

1. Click on your new service account
2. Go to the "Keys" tab
3. Click "Add Key" → "Create new key"
4. Choose **JSON** format
5. Download the key file

## 5. Configure Environment

1. Copy the downloaded JSON key file to a secure location
2. Set the path in your `.env` file:

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/your-service-account-key.json
```

**Important:** Never commit this JSON file to version control!

## 6. Test Your Setup

Run the bot with `npm run dev` and use the `!say` command to test text-to-speech.

## Pricing

Google Cloud offers a free tier:
- **Speech-to-Text**: 60 minutes/month free
- **Text-to-Speech**: 1 million characters/month free (Standard voices)

After the free tier, charges apply. Monitor your usage in the Google Cloud Console.

## Troubleshooting

### "Could not load credentials"
- Make sure `GOOGLE_APPLICATION_CREDENTIALS` points to the correct file
- Verify the file exists and is valid JSON
- Check file permissions (should be readable)

### "Permission denied" errors
- Verify your service account has the correct roles
- Make sure the APIs are enabled in your project

### "Quota exceeded" errors
- Check your usage in the Google Cloud Console
- Consider upgrading your plan if needed
