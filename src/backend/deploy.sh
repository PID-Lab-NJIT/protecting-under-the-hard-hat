#!/bin/bash
# Uploads a local directory to an AWS Lambda function

# --- Configuration & Colors ---
DEPLOY_BUCKET="deploy-bucket-protecting-under-the-hard-hat"   # S3 bucket used as a staging area for Lambda deployments
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# --- Step 1: Check AWS Login ---
aws sts get-caller-identity &> /dev/null
if [ $? -ne 0 ]; then
    echo -e "${RED}AWS credentials not found. Please run 'aws configure' first.${NC}"
    exit 1
fi

# --- Step 2: Validate Arguments ---
SKIP_LAYER=false
FUNC_ARG=""
for arg in "$@"; do
    if [ "$arg" = "--skip-layer" ]; then
        SKIP_LAYER=true
    elif [ -z "$FUNC_ARG" ]; then
        FUNC_ARG="$arg"
    fi
done

if [ -z "$FUNC_ARG" ]; then
    echo -e "${RED}Usage: ./deploy.sh <dirName> [--skip-layer]${NC}"
    echo "Example: ./deploy.sh process_response"
    echo "         ./deploy.sh process_response --skip-layer  (code-only deploy, skips layer update)"
    exit 2
fi

# --- Step 3: Identify Directory and Function Name ---
# process_response/ -> process_response
DIR_NAME=$(echo "$FUNC_ARG" | sed 's|/$||')

# Smart conversion: snake_case (dir name) to camelCase (func name)
# process_response -> processResponse
AWS_FUNC_NAME=$(echo "$DIR_NAME" | sed 's/_\([a-z]\)/\U\1/g')
ZIP_NAME="${AWS_FUNC_NAME}.zip"
LAYER_ZIP_NAME="${AWS_FUNC_NAME}-deps.zip"

echo -e "${YELLOW}--- 🚀 Starting Deployment for $AWS_FUNC_NAME ---${NC}"

if [ ! -d "$DIR_NAME" ]; then
    echo -e "${RED}❌ Error: Local directory '$DIR_NAME' not found.${NC}"
    exit 3
fi

# --- Step 4: Zip Directory Contents ---
echo -e "${YELLOW}📦 Packaging code from $DIR_NAME...${NC}"
rm -f "$ZIP_NAME"   # Remove old zip if exists
cd "$DIR_NAME" || exit 4

# Zip code only — node_modules live in the Lambda layer instead
if [ ! -f deploy_list.txt ]; then
	echo -e "${RED}❌ Error: deploy_list.txt not found.${NC}"
    exit 11
fi

zip -qr "../$ZIP_NAME" $(cat deploy_list.txt)

# Check if zip was successful
if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error: Failed to create zip file.${NC}"
    exit 5
fi

# Package node_modules as a Lambda layer
# (nodejs/node_modules/ structure required by Lambda layer)
if [ "$SKIP_LAYER" = false ]; then
    echo -e "${YELLOW}📦 Packaging dependencies as Lambda layer...${NC}"
    LAYER_TMP=$(mktemp -d)
    mkdir -p "$LAYER_TMP/nodejs"
    cp -r node_modules "$LAYER_TMP/nodejs/"
	# [TODO]
    # rm -rf "$LAYER_TMP/nodejs/node_modules/@aws-sdk"
    # rm -rf "$LAYER_TMP/nodejs/node_modules/@smithy"
    # rm -rf "$LAYER_TMP/nodejs/node_modules/@aws-crypto"
    # rm -rf "$LAYER_TMP/nodejs/node_modules/aws-sdk"
    # rm -rf "$LAYER_TMP/nodejs/node_modules/.bin"
    PREV_DIR=$(pwd)
    cd "$LAYER_TMP"
    zip -qr "$PREV_DIR/../$LAYER_ZIP_NAME" nodejs/
    LAYER_ZIP_STATUS=$?
    cd "$PREV_DIR"
    rm -rf "$LAYER_TMP"
    if [ $LAYER_ZIP_STATUS -ne 0 ]; then
        echo -e "${RED}❌ Error: Failed to create layer zip.${NC}"
        exit 5
    fi
fi

# --- Step 5: Merge .env to Lambda environment ---
echo -e "${YELLOW}Merging .env to Lambda environment...${NC}"
# Fetch current environment variables from AWS
CURRENT_VARS=$(aws lambda get-function-configuration \
    --function-name "$AWS_FUNC_NAME" \
    --query 'Environment.Variables' \
    --output json)

# Convert .env file to a JSON object
PATTERN="^[\"']|[\"']$"
LOCAL_VARS=$(jq -Rs --arg pattern "$PATTERN" '
  split("\n") 
  | map(select(length > 0 and (startswith("#") | not))) 
  | map(split("=")) 
  | map({(.[0]): (.[1] | gsub($pattern; ""))}) 
  | add
' private/.env)

# Merge them (Local variables will overwrite remote ones if keys match)
MERGED_VARS=$(echo "$CURRENT_VARS $LOCAL_VARS" | jq -s 'add')
FINAL_JSON=$(jq -n --argjson vars "$MERGED_VARS" '{Variables: $vars}')

# Push the update back to AWS
aws lambda update-function-configuration \
    --function-name "$AWS_FUNC_NAME" \
    --environment "$FINAL_JSON" > /dev/null

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error: Failed to merge .env to Lambda environment.${NC}"
    exit 6
fi

cd ..

# --- Step 5b: Publish and Attach Lambda Layer ---
if [ "$SKIP_LAYER" = false ]; then
    echo -e "${YELLOW}⏳ Waiting for env update to propagate before attaching layer...${NC}"
    aws lambda wait function-updated --function-name "$AWS_FUNC_NAME" > /dev/null

    echo -e "${YELLOW}☁️  Staging layer in S3...${NC}"
    LAYER_STAGE_OUTPUT=$(aws s3 cp "$LAYER_ZIP_NAME" "s3://$DEPLOY_BUCKET/layers/$LAYER_ZIP_NAME" 2>&1)
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Error: Layer S3 staging failed!${NC}"
        echo -e "$LAYER_STAGE_OUTPUT"
        rm -f "$ZIP_NAME" "$LAYER_ZIP_NAME"
        exit 6
    fi

    echo -e "${YELLOW}🗂️  Publishing Lambda layer version...${NC}"
    LAYER_ARN=$(aws lambda publish-layer-version \
        --layer-name "${AWS_FUNC_NAME}-deps" \
        --content S3Bucket="$DEPLOY_BUCKET",S3Key="layers/$LAYER_ZIP_NAME" \
        --compatible-runtimes nodejs20.x nodejs22.x \
        --query 'LayerVersionArn' --output text 2>&1)
    LAYER_PUBLISH_STATUS=$?
    aws s3 rm "s3://$DEPLOY_BUCKET/layers/$LAYER_ZIP_NAME" > /dev/null
    rm -f "$LAYER_ZIP_NAME"
    if [ $LAYER_PUBLISH_STATUS -ne 0 ]; then
        echo -e "${RED}❌ Error: Layer publish failed!${NC}"
        echo -e "$LAYER_ARN"
        rm -f "$ZIP_NAME"
        exit 6
    fi
    echo -e "${GREEN}✅ Layer published: $LAYER_ARN${NC}"

    echo -e "${YELLOW}🔗 Attaching layer to function...${NC}"
    ATTACH_OUTPUT=$(aws lambda update-function-configuration \
        --function-name "$AWS_FUNC_NAME" \
        --layers "$LAYER_ARN" 2>&1)
    if [ $? -ne 0 ]; then
        echo -e "${RED}❌ Error: Layer attachment failed!${NC}"
        echo -e "$ATTACH_OUTPUT"
        rm -f "$ZIP_NAME"
        exit 6
    fi
    echo -e "${GREEN}✅ Layer attached!${NC}"

    echo -e "${YELLOW}⏳ Waiting for layer attachment to propagate...${NC}"
    aws lambda wait function-updated --function-name "$AWS_FUNC_NAME" > /dev/null
fi

# --- Step 6: Verify Zip Contents ---
echo -e "${YELLOW}🔍 Verifying package contents...${NC}"
FORBIDDEN_FILES=$(unzip -l "$ZIP_NAME" | \
    grep -E ".env|service_account.json|service-account.json|private|aws-sdk|package-lock.json|test_input.js|node_modules|scratch.mjs")

if [ ! -z "$FORBIDDEN_FILES" ]; then
    echo -e "${RED}⚠️  WARNING: Forbidden files found in zip!${NC}"
    echo "$FORBIDDEN_FILES"
    echo -e "${RED}Aborting deployment for safety.${NC}"
    rm "$ZIP_NAME"
    exit 7
fi
echo -e "${GREEN}✅ No secrets or SDKs detected in package.${NC}"

# --- Step 7: Upload to AWS Lambda (via S3 to avoid 70MB direct upload limit) ---
echo -e "${YELLOW}☁️  Staging zip in S3...${NC}"
STAGE_OUTPUT=$(aws s3 cp "$ZIP_NAME" "s3://$DEPLOY_BUCKET/deployments/$ZIP_NAME" 2>&1)

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error: S3 staging failed!${NC}"
    echo -e "$STAGE_OUTPUT"
    rm "$ZIP_NAME"
    exit 8
fi

echo -e "${YELLOW}☁️  Deploying to Lambda from S3...${NC}"
UPLOAD_OUTPUT=$(aws lambda update-function-code \
    --function-name "$AWS_FUNC_NAME" \
    --s3-bucket "$DEPLOY_BUCKET" \
    --s3-key "deployments/$ZIP_NAME" 2>&1)

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error: AWS upload failed!${NC}"
    echo -e "$UPLOAD_OUTPUT"
    aws s3 rm "s3://$DEPLOY_BUCKET/deployments/$ZIP_NAME" > /dev/null
    rm "$ZIP_NAME"
    exit 8
fi

echo -e "${YELLOW}🧹 Removing staged zip from S3...${NC}"
aws s3 rm "s3://$DEPLOY_BUCKET/deployments/$ZIP_NAME" > /dev/null

echo -e "${GREEN}✅ Upload successful!${NC}"

# --- Wait for the update to finish propagating ---
echo -e "${YELLOW}⏳ Waiting for function update to complete...${NC}"
PROPAGATION_OUTPUT=$(aws lambda wait function-updated --function-name "$AWS_FUNC_NAME" 2>&1)

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Error: Propagation failed!${NC}"
    echo -e "$PROPAGATION_OUTPUT"
    rm "$ZIP_NAME"
    exit 9
fi

echo -e "${GREEN}✅ Propagation successful!${NC}"

# --- Step 8: Smoke Test (Invoke) ---
echo -e "${YELLOW}🧪 Running smoke test...${NC}"
if [ -f "$DIR_NAME/test-input.js" ]; then
    PAYLOAD=$(node $DIR_NAME/test-input.js)
else
    echo -e "${YELLOW}⚠️ Warning: No payload file found${NC}"
    PAYLOAD="{}"
fi
aws lambda invoke \
    --function-name "$AWS_FUNC_NAME" \
    --payload "$PAYLOAD" \
    --cli-binary-format raw-in-base64-out \
    response.json > /dev/null

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✅ Test triggered successfully.${NC}"
    echo -e "${YELLOW}📄 Function response:${NC}"
    cat response.json
    echo -e ""
else
    echo -e "${RED}❌ Smoke test failed.${NC}"
    echo -e "${YELLOW}🔍 Fetching last 10 log events from CloudWatch...${NC}"
    
    # Get the latest log stream name
    STREAM=$(aws logs describe-log-streams \
        --log-group-name "/aws/lambda/$AWS_FUNC_NAME" \
        --order-by LastEventTime --descending --limit 1 \
        --query 'logStreams[0].logStreamName' --output text)

    # Print the last 10 lines of that stream
    aws logs get-log-events \
        --log-group-name "/aws/lambda/$AWS_FUNC_NAME" \
        --log-stream-name "$STREAM" \
        --limit 10 --query 'events[*].message' --output text
    
    exit 10
fi

# --- Step 9: Final Cleanup ---
echo -e "${YELLOW}🧹 Cleaning up temporary files...${NC}"
rm -f "$ZIP_NAME" "$LAYER_ZIP_NAME" response.json
echo -e "${GREEN}--- ✨ Deployment complete ---${NC}"
