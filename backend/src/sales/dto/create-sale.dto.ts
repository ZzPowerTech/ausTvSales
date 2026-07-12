import {
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreateSaleDto {
  @IsUUID()
  sale_id!: string;

  @IsString()
  @IsNotEmpty()
  item_id!: string;

  @IsUUID()
  player_uuid!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  total_price!: number;

  @IsInt()
  @Min(1)
  qtd!: number;

  @IsISO8601()
  purchased_at!: string;
}
