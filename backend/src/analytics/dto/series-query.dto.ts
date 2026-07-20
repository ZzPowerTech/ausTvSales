import { IsIn, IsOptional } from 'class-validator';
import { PeriodQueryDto } from './period-query.dto';

/** Time buckets the series supports; all map to a Postgres `date_trunc` unit. */
export const SERIES_BUCKETS = ['day', 'week', 'month'] as const;
export type SeriesBucket = (typeof SERIES_BUCKETS)[number];

export const DEFAULT_SERIES_BUCKET: SeriesBucket = 'day';

/**
 * Series query (spec S5.1 §2.1). Inherits the period filter and adds an optional
 * `bucket` granularity (day by default). The bucket count is capped in the
 * service (§2.8) so a wide window at `day` cannot return thousands of points.
 */
export class SeriesQueryDto extends PeriodQueryDto {
  @IsOptional()
  @IsIn(SERIES_BUCKETS, {
    message: `bucket must be one of: ${SERIES_BUCKETS.join(', ')}`,
  })
  bucket?: SeriesBucket;
}
