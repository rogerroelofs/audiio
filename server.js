require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { 
    TranscribeStreamingClient, 
    StartStreamTranscriptionCommand 
} = require("@aws-sdk/client-transcribe-streaming");
const { 
    BedrockRuntimeClient, 
    InvokeModelCommand 
} = require("@aws-sdk/client-bedrock-runtime");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Configure AWS clients
const transcribeClient = new TranscribeStreamingClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

const bedrockClient = new BedrockRuntimeClient({
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// Audio configuration
const SAMPLE_RATE = 16000;

// Serve static files from public directory
app.use(express.static('public'));

// Process transcript with Bedrock
async function processWithBedrock(transcript) {
    try {
        const prompt = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 2048,
            temperature: 0.7,
            top_p: 0.9,
            system: "You are a professional editor who helps make text more polished and professional while maintaining its original meaning. You return the polished transcript with no indication you were involved in the editing:",
            messages: [
                {
                    role: "user",
                    content: `Please make the following transcript sound more professional and polished, while maintaining its original meaning. Please return the polished version only without preamble:\n\n${transcript}`
                }
            ]
        };

        const command = new InvokeModelCommand({
            modelId: "anthropic.claude-instant-v1",
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(prompt)
        });

        const response = await bedrockClient.send(command);
        const result = JSON.parse(new TextDecoder().decode(response.body));
        
        if (result.error) {
            throw new Error(result.error.message || 'Unknown Bedrock error');
        }
        console.log(result);
        return result.content?.[0]?.text || result.completion || 'Error: No response from AI';
    } catch (error) {
        console.error('Bedrock processing error:', error.message);
        throw error;
    }
}

// WebSocket connection handling
wss.on('connection', (ws) => {
    console.log('Client connected');
    let transcriptionStream = null;
    let lastAudioTimestamp = null;
    let timeoutChecker = null;
    let audioQueue = [];
    let streamEnded = false;
    let isProcessingStream = false;

    const TIMEOUT_DURATION = 12000;

    // Function to create async iterator for audio stream
    async function* createAudioStream() {
        try {
            while (!streamEnded || audioQueue.length > 0) {
                if (audioQueue.length > 0) {
                    yield { AudioEvent: { AudioChunk: audioQueue.shift() } };
                } else {
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
        } catch (error) {
            console.error('Audio stream error:', error.message);
            throw error;
        }
    }

    // Function to close transcription stream
    const closeTranscriptionStream = () => {
        if (transcriptionStream) {
            console.log('Closing transcription stream');
            streamEnded = true;
            transcriptionStream = null;
            isProcessingStream = false;
            ws.send(JSON.stringify({ type: 'status', message: 'Stopped listening' }));
        }
    };

    // Function to start timeout checker
    const startTimeoutChecker = () => {
        if (timeoutChecker) {
            clearInterval(timeoutChecker);
        }
        timeoutChecker = setInterval(() => {
            if (lastAudioTimestamp && (Date.now() - lastAudioTimestamp) > TIMEOUT_DURATION) {
                console.log('Stream timeout detected');
                closeTranscriptionStream();
                clearInterval(timeoutChecker);
                timeoutChecker = null;
            }
        }, 1000);
    };

    // Function to start transcription
    const startTranscription = async () => {
        if (isProcessingStream) return;

        try {
            isProcessingStream = true;
            streamEnded = false;
            
            const command = new StartStreamTranscriptionCommand({
                LanguageCode: 'en-US',
                MediaEncoding: 'pcm',
                MediaSampleRateHertz: SAMPLE_RATE,
                AudioStream: createAudioStream(),
                EnablePartialResultsStabilization: true,
                PartialResultsStability: "high",
                ShowSpeakerLabels: false,
                EnableChannelIdentification: false
            });

            transcriptionStream = await transcribeClient.send(command);
            console.log('Connected to AWS Transcribe');

            try {
                for await (const event of transcriptionStream.TranscriptResultStream) {
                    if (!isProcessingStream) break;

                    if (event.TranscriptEvent?.Transcript?.Results?.length > 0) {
                        const result = event.TranscriptEvent.Transcript.Results[0];
                        if (result.Alternatives?.length > 0) {
                            const transcription = result.Alternatives[0].Transcript;
                            if (transcription) {
                                ws.send(JSON.stringify({ 
                                    type: 'transcription',
                                    text: transcription,
                                    isPartial: result.IsPartial
                                }));
                            }
                        }
                    } else if (event.BadRequestException) {
                        console.error('Transcribe error:', event.BadRequestException.message);
                        ws.send(JSON.stringify({ type: 'error', message: 'Transcription error' }));
                    }
                }
            } catch (streamError) {
                console.error('Stream error:', streamError.message);
                throw streamError;
            }
        } catch (error) {
            console.error('Transcription error:', error.message);
            ws.send(JSON.stringify({ type: 'error', message: 'Transcription failed' }));
            transcriptionStream = null;
        } finally {
            isProcessingStream = false;
        }
    };

    ws.on('message', async (data) => {
        try {
            // Check if the message is a text command
            if (data instanceof Buffer) {
                const textData = data.toString();
                if (textData.startsWith('{') && textData.endsWith('}')) {
                    try {
                        console.log(textData);
                        const message = JSON.parse(textData);
                        if (message.type === 'processTranscript' && message.text) {
                            try {
                                const processedText = await processWithBedrock(message.text);
                                ws.send(JSON.stringify({
                                    type: 'processedTranscription',
                                    text: processedText
                                }));
                            } catch (error) {
                                console.error('Processing error:', error.message);
                                ws.send(JSON.stringify({
                                    type: 'error',
                                    message: 'Failed to process transcript'
                                }));
                            }
                        }
                        return;
                    } catch (parseError) {
                        console.error('JSON parse error:', parseError.message);
                    }
                }
            }

            // Handle audio data
            const audioChunk = data;
            lastAudioTimestamp = Date.now();
            startTimeoutChecker();

            if (!transcriptionStream && !isProcessingStream) {
                audioQueue = [audioChunk];
                await startTranscription();
            } else {
                audioQueue.push(audioChunk);
            }
        } catch (error) {
            console.error('Audio processing error:', error.message);
            ws.send(JSON.stringify({ type: 'error', message: 'Processing failed' }));
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (timeoutChecker) {
            clearInterval(timeoutChecker);
        }
        closeTranscriptionStream();
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});