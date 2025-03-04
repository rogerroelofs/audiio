# Audio Transcription App

This is a web application that captures audio using the Web Audio API and streams it to a server via WebSocket for transcription. The user can also send the transcribed text to an AI service for further processing.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Get the AWS tokens and create the .env file:
   ```text
   AWS_ACCESS_KEY_ID=
   AWS_SECRET_ACCESS_KEY=
   AWS_REGION=us-east-1
   ```
   Your IAM user needs access to both the Transcribe and Bedrock services.
   You can create the IAM user using the aws cli:
    ```bash
   aws iam create-user --user-name TranscribeBedrock_User
   aws iam create-policy --policy-name TranscribeBedrock_Policy --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": [
                "transcribe:*",
                "bedrock:InvokeModel"
            ],
            "Resource": "*"
        }
    ]
   }'
   aws iam attach-user-policy --user-name TranscribeBedrock_User --policy-arn arn:aws:iam::<your-account-id>:policy/TranscribeBedrock_Policy
   aws iam create-access-key --user-name TranscribeBedrock_User
   ```

2. Start the server:
   ```bash
   npm run start
   ```