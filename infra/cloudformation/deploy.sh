#!/bin/bash
set -euo pipefail

STACK_NAME="openmercato"
REGION="eu-west-2"
TEMPLATE="$(dirname "$0")/openmercato.yml"

# Required parameters - set these or pass as env vars
: "${APP_IMAGE:?Set APP_IMAGE (e.g. 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest)}"
: "${JWT_SECRET_ARN:?Set JWT_SECRET_ARN}"
: "${ENCRYPTION_KEY_ARN:?Set ENCRYPTION_KEY_ARN}"

ACTION="${1:-deploy}"

case "$ACTION" in
  create)
    echo "Creating stack ${STACK_NAME}..."
    aws cloudformation create-stack \
      --stack-name "$STACK_NAME" \
      --template-body "file://${TEMPLATE}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$REGION" \
      --parameters \
        "ParameterKey=AppImage,ParameterValue=${APP_IMAGE}" \
        "ParameterKey=JwtSecretArn,ParameterValue=${JWT_SECRET_ARN}" \
        "ParameterKey=EncryptionKeyArn,ParameterValue=${ENCRYPTION_KEY_ARN}"
    echo "Waiting for stack creation..."
    aws cloudformation wait stack-create-complete --stack-name "$STACK_NAME" --region "$REGION"
    echo "Stack created."
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs' --output table
    ;;

  update)
    echo "Updating stack ${STACK_NAME}..."
    aws cloudformation update-stack \
      --stack-name "$STACK_NAME" \
      --template-body "file://${TEMPLATE}" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$REGION" \
      --parameters \
        "ParameterKey=AppImage,ParameterValue=${APP_IMAGE}" \
        "ParameterKey=JwtSecretArn,ParameterValue=${JWT_SECRET_ARN}" \
        "ParameterKey=EncryptionKeyArn,ParameterValue=${ENCRYPTION_KEY_ARN}"
    echo "Waiting for stack update..."
    aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" --region "$REGION"
    echo "Stack updated."
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs' --output table
    ;;

  deploy)
    echo "Deploying stack ${STACK_NAME}..."
    aws cloudformation deploy \
      --stack-name "$STACK_NAME" \
      --template-file "$TEMPLATE" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$REGION" \
      --parameter-overrides \
        "AppImage=${APP_IMAGE}" \
        "JwtSecretArn=${JWT_SECRET_ARN}" \
        "EncryptionKeyArn=${ENCRYPTION_KEY_ARN}"
    echo "Deployed."
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs' --output table
    ;;

  status)
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}' --output json
    ;;

  events)
    aws cloudformation describe-stack-events --stack-name "$STACK_NAME" --region "$REGION" --query 'StackEvents[0:10].{Time:Timestamp,Status:ResourceStatus,Resource:LogicalResourceId,Reason:ResourceStatusReason}' --output table
    ;;

  destroy)
    echo "WARNING: This will destroy all resources in stack ${STACK_NAME}."
    echo "You must first disable RDS deletion protection manually."
    read -p "Continue? (yes/no): " confirm
    if [ "$confirm" = "yes" ]; then
      aws cloudformation delete-stack --stack-name "$STACK_NAME" --region "$REGION"
      echo "Waiting for stack deletion..."
      aws cloudformation wait stack-delete-complete --stack-name "$STACK_NAME" --region "$REGION"
      echo "Stack deleted."
    fi
    ;;

  *)
    echo "Usage: $0 {create|update|deploy|status|events|destroy}"
    echo ""
    echo "Required env vars: APP_IMAGE, JWT_SECRET_ARN, ENCRYPTION_KEY_ARN"
    exit 1
    ;;
esac
