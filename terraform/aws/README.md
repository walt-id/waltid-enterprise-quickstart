# AWS Terraform Deployment

This directory is split into two stages:

- `infra/`: Core AWS and cluster infrastructure
- `platform/`: Application/platform deployment on top of the cluster

## Structure

- `infra/` provisions VPC, EKS, node groups, add-ons, ingress, and DocumentDB.
- `platform/` deploys the Walt.id Enterprise Helm release and related Kubernetes resources.

## Deployment Order

### 1) Deploy infrastructure

```bash
cd terraform/aws/infra
terraform init
terraform apply -var-file=env/dev.tfvars
```

For production:

```bash
terraform apply -var-file=env/prod.tfvars
```

### 2) Point DNS to Ingress NGINX load balancer

Get the LB hostname from infra output:

```bash
cd terraform/aws/infra
terraform output ingress_nginx_lb
```

Create/update DNS for your domain to point to this load balancer (Route53 alias or CNAME as appropriate).

Verify DNS resolution:

```bash
dig +short <your-domain>
```

TLS/ACME validation requires DNS to be correct before platform deployment.

### 3) Deploy platform

Get MongoDB connection string from infra:

```bash
cd terraform/aws/infra
terraform output -raw mongodb_connection_string
```

Deploy platform with required variable values:

```bash
cd ../platform
terraform init
terraform apply \
  -var='cluster_name=<EKS_CLUSTER_NAME>' \
  -var='aws_region=<AWS_REGION>' \
  -var='mongodb_connection_string=<MONGODB_CONNECTION_STRING>' \
  -var='domain=<your-domain>' \
  -var='dockerhub_secret=<dockerhub-token>'
```

## Notes

- Run `terraform init` separately in `infra/` and `platform/`.
- Keep sensitive values (MongoDB URI, DockerHub token) out of shell history where possible.
- `infra/` and `platform/` intentionally use separate Terraform states.
