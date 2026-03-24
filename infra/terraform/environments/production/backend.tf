terraform {
  backend "s3" {
    bucket         = "openmercato-terraform-state-062648047691-eu-west-2"
    key            = "production/terraform.tfstate"
    region         = "eu-west-2"
    dynamodb_table = "openmercato-terraform-locks"
    encrypt        = true
  }
}
