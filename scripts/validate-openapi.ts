import SwaggerParser from '@apidevtools/swagger-parser';
import { OPENAPI_SPEC } from '@/openapi';
import type { OpenAPI } from 'openapi-types';
const run = async () => {
  const api = await SwaggerParser.validate(OPENAPI_SPEC as unknown as OpenAPI.Document);
  const title = api.info?.title ?? 'OpenAPI';
  const version = api.info?.version ?? '';
  console.log(`✓ ${title} ${version} schema is valid.`);
};
run().catch((error) => {
  console.error('OpenAPI schema validation failed.');
  if (error instanceof Error) {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(1);
});
