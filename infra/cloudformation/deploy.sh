#!/bin/bash
set -euo pipefail

STACK_NAME="openmercato"
REGION="eu-west-2"
TEMPLATE="$(dirname "$0")/openmercato.yml"
CFN_S3_BUCKET="${CFN_S3_BUCKET:-openmercato-terraform-state-062648047691-eu-west-2}"
CFN_S3_PREFIX="${CFN_S3_PREFIX:-cloudformation}"

# Required parameters - set these or pass as env vars
: "${APP_IMAGE:?Set APP_IMAGE (e.g. 062648047691.dkr.ecr.eu-west-2.amazonaws.com/openmercato-app:latest)}"
: "${JWT_SECRET_ARN:?Set JWT_SECRET_ARN}"
: "${ENCRYPTION_KEY_ARN:?Set ENCRYPTION_KEY_ARN}"
: "${REDIS_PARAMETER_GROUP_NAME:?Set REDIS_PARAMETER_GROUP_NAME}"

ACTION="${1:-deploy}"
CHANGE_SET_NAME="${CHANGE_SET_NAME:-}"

parameter_overrides=(
  "AppImage=${APP_IMAGE}"
  "JwtSecretArn=${JWT_SECRET_ARN}"
  "EncryptionKeyArn=${ENCRYPTION_KEY_ARN}"
  "ExistingRedisParameterGroupName=${REDIS_PARAMETER_GROUP_NAME}"
)

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
        "ParameterKey=EncryptionKeyArn,ParameterValue=${ENCRYPTION_KEY_ARN}" \
        "ParameterKey=ExistingRedisParameterGroupName,ParameterValue=${REDIS_PARAMETER_GROUP_NAME}"
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
        "ParameterKey=EncryptionKeyArn,ParameterValue=${ENCRYPTION_KEY_ARN}" \
        "ParameterKey=ExistingRedisParameterGroupName,ParameterValue=${REDIS_PARAMETER_GROUP_NAME}"
    echo "Waiting for stack update..."
    aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" --region "$REGION"
    echo "Stack updated."
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs' --output table
    ;;

  changeset)
    echo "Creating change set for stack ${STACK_NAME}..."
    aws cloudformation deploy \
      --stack-name "$STACK_NAME" \
      --template-file "$TEMPLATE" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$REGION" \
      --s3-bucket "$CFN_S3_BUCKET" \
      --s3-prefix "$CFN_S3_PREFIX" \
      --no-execute-changeset \
      --no-fail-on-empty-changeset \
      --parameter-overrides "${parameter_overrides[@]}"
    LATEST_CHANGE_SET_NAME="$(
      aws cloudformation list-change-sets \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'sort_by(Summaries,&CreationTime)[-1].ChangeSetName' \
        --output text
    )"
    echo "Latest change set: ${LATEST_CHANGE_SET_NAME}"
    aws cloudformation describe-change-set \
      --stack-name "$STACK_NAME" \
      --change-set-name "$LATEST_CHANGE_SET_NAME" \
      --region "$REGION" \
      --output table
    ;;

  execute-changeset)
    CHANGE_SET_TO_EXECUTE="${CHANGE_SET_NAME:-$(
      aws cloudformation list-change-sets \
        --stack-name "$STACK_NAME" \
        --region "$REGION" \
        --query 'sort_by(Summaries,&CreationTime)[-1].ChangeSetName' \
        --output text
    )}"
    echo "Executing change set ${CHANGE_SET_TO_EXECUTE} for stack ${STACK_NAME}..."
    aws cloudformation execute-change-set \
      --stack-name "$STACK_NAME" \
      --change-set-name "$CHANGE_SET_TO_EXECUTE" \
      --region "$REGION"
    echo "Waiting for stack update..."
    aws cloudformation wait stack-update-complete --stack-name "$STACK_NAME" --region "$REGION"
    echo "Change set executed."
    aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" --query 'Stacks[0].Outputs' --output table
    ;;

  deploy)
    echo "Deploying stack ${STACK_NAME}..."
    aws cloudformation deploy \
      --stack-name "$STACK_NAME" \
      --template-file "$TEMPLATE" \
      --capabilities CAPABILITY_NAMED_IAM \
      --region "$REGION" \
      --s3-bucket "$CFN_S3_BUCKET" \
      --s3-prefix "$CFN_S3_PREFIX" \
      --no-fail-on-empty-changeset \
      --parameter-overrides "${parameter_overrides[@]}"
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
    echo "Usage: $0 {create|update|changeset|execute-changeset|deploy|status|events|destroy}"
    echo ""
    echo "Required env vars: APP_IMAGE, JWT_SECRET_ARN, ENCRYPTION_KEY_ARN, REDIS_PARAMETER_GROUP_NAME"
    exit 1
    ;;
esac
