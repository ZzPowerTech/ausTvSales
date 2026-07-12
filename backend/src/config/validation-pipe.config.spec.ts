import {
  ArgumentMetadata,
  BadRequestException,
  ValidationPipe,
} from '@nestjs/common';
import { CreateSaleDto } from '../sales/dto/create-sale.dto';
import { validationPipeOptions } from './validation-pipe.config';

const validPayload = {
  sale_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  item_id: 'caixaNatal2026',
  player_uuid: '9c858901-8a57-4791-81fe-4c455b099bc9',
  total_price: 19.9,
  qtd: 1,
  purchased_at: '2026-07-12T10:30:00.000Z',
};

const metadata: ArgumentMetadata = {
  type: 'body',
  metatype: CreateSaleDto,
  data: '',
};

describe('validationPipeOptions', () => {
  const pipe = new ValidationPipe(validationPipeOptions);

  it('accepts a valid payload and transforms it into a DTO instance', async () => {
    const result = (await pipe.transform(
      validPayload,
      metadata,
    )) as CreateSaleDto;

    expect(result).toBeInstanceOf(CreateSaleDto);
  });

  it('rejects a payload with an invalid field', async () => {
    await expect(
      pipe.transform({ ...validPayload, qtd: 0 }, metadata),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a payload with fields outside the DTO (forbidNonWhitelisted)', async () => {
    await expect(
      pipe.transform({ ...validPayload, unexpected_field: 'x' }, metadata),
    ).rejects.toThrow(BadRequestException);
  });

  it('strips fields outside the DTO instead of silently accepting them', async () => {
    const pipeWithoutForbid = new ValidationPipe({
      ...validationPipeOptions,
      forbidNonWhitelisted: false,
    });

    const result = (await pipeWithoutForbid.transform(
      { ...validPayload, unexpected_field: 'x' },
      metadata,
    )) as Record<string, unknown>;

    expect(result.unexpected_field).toBeUndefined();
  });
});
