#!/usr/bin/env node

import {
  Client,
  GatewayIntentBits,
  VoiceState,
  Message,
} from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnection,
  getVoiceConnection,
  EndBehaviorType,
} from '@discordjs/voice';
import { createWriteStream, createReadStream, unlinkSync, readFileSync } from 'fs';
import { pipeline } from 'stream/promises';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
import Anthropic from '@anthropic-ai/sdk';
import { config } from 'dotenv';
import prism from 'prism-media';
import { OpusEncoder } from '@discordjs/opus';

config();

// Initialize Google Cloud clients (for Speech-to-Text and Text-to-Speech)
const speechClient = new SpeechClient();
const ttsClient = new TextToSpeechClient();

// Initialize Anthropic client (for Claude AI responses)
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

// Track active voice connections and recordings
const connections = new Map<string, VoiceConnection>();
const recordings = new Map<string, Map<string, NodeJS.WritableStream>>();
const audioPlayers = new Map<string, ReturnType<typeof createAudioPlayer>>();

/**
 * Convert PCM audio to FLAC format (for Google Speech-to-Text API)
 */
function pcmToFlac(pcmFile: string, flacFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ffmpeg = require('ffmpeg-static');
    const { spawn } = require('child_process');

    const process = spawn(ffmpeg, [
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2',
      '-i', pcmFile,
      flacFile
    ]);

    process.on('close', (code: number) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}`));
    });

    process.on('error', reject);
  });
}

/**
 * Transcribe audio using Google Cloud Speech-to-Text
 */
async function transcribeAudio(audioFilePath: string): Promise<string> {
  try {
    const audioBytes = readFileSync(audioFilePath).toString('base64');

    const request = {
      audio: {
        content: audioBytes,
      },
      config: {
        encoding: 'FLAC' as const,
        sampleRateHertz: 48000,
        languageCode: 'en-US',
        audioChannelCount: 2,
      },
    };

    const [response] = await speechClient.recognize(request);
    const transcription = response.results
      ?.map(result => result.alternatives?.[0]?.transcript)
      .filter(Boolean)
      .join('\n') || '';

    return transcription;
  } catch (error) {
    console.error('Transcription error:', error);
    throw error;
  }
}

/**
 * Generate speech using Google Cloud Text-to-Speech
 */
async function generateSpeech(text: string, outputPath: string): Promise<void> {
  try {
    const request = {
      input: { text },
      voice: {
        languageCode: 'en-US',
        name: 'en-US-Neural2-C', // Female voice
        ssmlGender: 'FEMALE' as const,
      },
      audioConfig: {
        audioEncoding: 'MP3' as const,
      },
    };

    const [response] = await ttsClient.synthesizeSpeech(request);
    if (response.audioContent) {
      await require('fs').promises.writeFile(outputPath, response.audioContent);
    }
  } catch (error) {
    console.error('TTS error:', error);
    throw error;
  }
}

/**
 * Get AI response from Claude (via Anthropic API)
 */
async function getAIResponse(userMessage: string): Promise<string> {
  try {
    const message = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 150,
      system: 'You are a helpful voice assistant in a Discord server. Keep responses concise and conversational since they will be spoken aloud. Aim for responses that are 1-3 sentences.',
      messages: [
        {
          role: 'user',
          content: userMessage,
        },
      ],
    });

    const textBlock = message.content.find(block => block.type === 'text');
    return textBlock?.text || 'Sorry, I could not generate a response.';
  } catch (error) {
    console.error('AI response error:', error);
    return 'Sorry, I encountered an error processing your request.';
  }
}

/**
 * Play audio in voice channel
 */
async function playAudioInChannel(guildId: string, audioFilePath: string): Promise<void> {
  const connection = connections.get(guildId);
  if (!connection) {
    throw new Error('No voice connection found');
  }

  let player = audioPlayers.get(guildId);
  if (!player) {
    player = createAudioPlayer();
    audioPlayers.set(guildId, player);
    connection.subscribe(player);
  }

  const resource = createAudioResource(audioFilePath);
  player.play(resource);

  return new Promise((resolve, reject) => {
    player!.once(AudioPlayerStatus.Idle, () => {
      resolve();
    });
    player!.once('error', reject);
  });
}

/**
 * Start recording a user's audio
 */
function startRecording(connection: VoiceConnection, userId: string, guildId: string): void {
  const receiver = connection.receiver;

  const audioStream = receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1000, // 1 second of silence ends the recording
    },
  });

  const filename = `/tmp/discord-voice-${guildId}-${userId}-${Date.now()}.pcm`;
  const writeStream = createWriteStream(filename);

  // Store the stream
  if (!recordings.has(guildId)) {
    recordings.set(guildId, new Map());
  }
  recordings.get(guildId)!.set(userId, writeStream);

  // Decode opus to PCM
  const opusDecoder = new prism.opus.Decoder({
    frameSize: 960,
    channels: 2,
    rate: 48000,
  });

  audioStream.pipe(opusDecoder).pipe(writeStream);

  // When recording ends (after silence)
  audioStream.once('end', async () => {
    writeStream.end();
    recordings.get(guildId)?.delete(userId);

    // Wait a bit for file to be written
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
      // Convert PCM to FLAC
      const flacFilename = filename.replace('.pcm', '.flac');
      await pcmToFlac(filename, flacFilename);

      // Transcribe
      console.log(`Transcribing audio for user ${userId}...`);
      const transcript = await transcribeAudio(flacFilename);
      console.log(`Transcript: ${transcript}`);

      if (transcript.trim().length > 0) {
        // Get AI response
        console.log('Generating AI response...');
        const aiResponse = await getAIResponse(transcript);
        console.log(`AI Response: ${aiResponse}`);

        // Generate speech
        const responseAudioPath = `/tmp/discord-voice-response-${guildId}-${Date.now()}.mp3`;
        await generateSpeech(aiResponse, responseAudioPath);

        // Play response
        await playAudioInChannel(guildId, responseAudioPath);

        // Cleanup
        unlinkSync(responseAudioPath);
      }

      // Cleanup temp files
      unlinkSync(filename);
      unlinkSync(flacFilename);
    } catch (error) {
      console.error('Error processing audio:', error);
    }
  });
}

/**
 * Join a voice channel
 */
function joinChannel(channelId: string, guildId: string, adapterCreator: any): VoiceConnection {
  const connection = joinVoiceChannel({
    channelId,
    guildId,
    adapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  connections.set(guildId, connection);

  // Start listening to all users
  connection.receiver.speaking.on('start', (userId) => {
    console.log(`User ${userId} started speaking`);
    startRecording(connection, userId, guildId);
  });

  return connection;
}

/**
 * Leave voice channel
 */
function leaveChannel(guildId: string): void {
  const connection = connections.get(guildId);
  if (connection) {
    connection.destroy();
    connections.delete(guildId);
    audioPlayers.delete(guildId);
    recordings.delete(guildId);
  }
}

// Bot ready event
client.once('ready', () => {
  console.log(`Voice bot logged in as ${client.user?.tag}`);
  console.log('Commands:');
  console.log('  !join - Join your current voice channel');
  console.log('  !leave - Leave the voice channel');
  console.log('  !say <text> - Speak text in voice channel');
});

// Message handler for commands
client.on('messageCreate', async (message: Message) => {
  if (message.author.bot) return;
  if (!message.content.startsWith('!')) return;

  const args = message.content.slice(1).split(' ');
  const command = args[0].toLowerCase();

  if (command === 'join') {
    const member = message.guild?.members.cache.get(message.author.id);
    const voiceChannel = member?.voice.channel;

    if (!voiceChannel) {
      await message.reply('You need to be in a voice channel first!');
      return;
    }

    try {
      joinChannel(
        voiceChannel.id,
        message.guild!.id,
        message.guild!.voiceAdapterCreator
      );
      await message.reply(`Joined ${voiceChannel.name}! Start speaking and I'll respond.`);
    } catch (error) {
      console.error('Error joining channel:', error);
      await message.reply('Failed to join voice channel.');
    }
  }

  if (command === 'leave') {
    leaveChannel(message.guild!.id);
    await message.reply('Left the voice channel.');
  }

  if (command === 'say') {
    const text = args.slice(1).join(' ');
    if (!text) {
      await message.reply('Please provide text to say!');
      return;
    }

    try {
      const audioPath = `/tmp/discord-voice-say-${Date.now()}.mp3`;
      await generateSpeech(text, audioPath);
      await playAudioInChannel(message.guild!.id, audioPath);
      unlinkSync(audioPath);
      await message.reply('✅ Spoken!');
    } catch (error) {
      console.error('Error speaking:', error);
      await message.reply('Failed to speak in voice channel.');
    }
  }
});

// Error handling
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

// Login
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
  console.error('DISCORD_BOT_TOKEN not found in environment');
  process.exit(1);
}

client.login(token);
