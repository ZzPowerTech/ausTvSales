import { plainToInstance } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum Environment {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export class EnvironmentVariables {
  @IsEnum(Environment)
  NODE_ENV: Environment = Environment.Development;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(65535)
  PORT?: number;

  // PostgreSQL connection string (shared instance with AusTV Finance —
  // uses a dedicated database/user for austv-sales, spec §8).
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message:
      'DATABASE_URL must be a postgres:// or postgresql:// connection string',
  })
  DATABASE_URL!: string;
}

export function validateEnv(
  config: Record<string, unknown>,
): EnvironmentVariables {
  const validatedConfig = plainToInstance(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: false,
  });

  if (errors.length > 0) {
    const details = errors
      .map(
        (error) =>
          `${error.property}: ${Object.values(error.constraints ?? {}).join(', ')}`,
      )
      .join('; ');
    throw new Error(`Invalid environment configuration — ${details}`);
  }

  return validatedConfig;
}
