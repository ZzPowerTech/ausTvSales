import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateSaleDto } from './create-sale.dto';

const validPayload = {
  sale_id: '3fa85f64-5717-4562-b3fc-2c963f66afa6',
  item_id: 'caixaNatal2026',
  player_uuid: '9c858901-8a57-4791-81fe-4c455b099bc9',
  nickname_at_purchase: 'Murilo',
  total_price: 19.9,
  qtd: 1,
  purchased_at: '2026-07-12T10:30:00.000Z',
};

async function validatePayload(payload: Record<string, unknown>) {
  const dto = plainToInstance(CreateSaleDto, payload);
  return validate(dto);
}

describe('CreateSaleDto', () => {
  it('accepts a valid payload', async () => {
    const errors = await validatePayload(validPayload);

    expect(errors).toHaveLength(0);
  });

  it('rejects a sale_id that is not a UUID', async () => {
    const errors = await validatePayload({
      ...validPayload,
      sale_id: 'not-a-uuid',
    });

    expect(errors.some((error) => error.property === 'sale_id')).toBe(true);
  });

  it('rejects an empty item_id', async () => {
    const errors = await validatePayload({ ...validPayload, item_id: '' });

    expect(errors.some((error) => error.property === 'item_id')).toBe(true);
  });

  it('rejects a non-string item_id', async () => {
    const errors = await validatePayload({ ...validPayload, item_id: 123 });

    expect(errors.some((error) => error.property === 'item_id')).toBe(true);
  });

  it('rejects a player_uuid that is not a UUID', async () => {
    const errors = await validatePayload({
      ...validPayload,
      player_uuid: 'not-a-uuid',
    });

    expect(errors.some((error) => error.property === 'player_uuid')).toBe(true);
  });

  it('rejects an empty nickname_at_purchase', async () => {
    const errors = await validatePayload({
      ...validPayload,
      nickname_at_purchase: '',
    });

    expect(
      errors.some((error) => error.property === 'nickname_at_purchase'),
    ).toBe(true);
  });

  it('rejects a missing nickname_at_purchase', async () => {
    const withoutNick: Record<string, unknown> = { ...validPayload };
    delete withoutNick.nickname_at_purchase;
    const errors = await validatePayload(withoutNick);

    expect(
      errors.some((error) => error.property === 'nickname_at_purchase'),
    ).toBe(true);
  });

  it('rejects a zero total_price', async () => {
    const errors = await validatePayload({ ...validPayload, total_price: 0 });

    expect(errors.some((error) => error.property === 'total_price')).toBe(true);
  });

  it('rejects a negative total_price', async () => {
    const errors = await validatePayload({ ...validPayload, total_price: -10 });

    expect(errors.some((error) => error.property === 'total_price')).toBe(true);
  });

  it('rejects a total_price with more than two decimal places', async () => {
    const errors = await validatePayload({
      ...validPayload,
      total_price: 19.999,
    });

    expect(errors.some((error) => error.property === 'total_price')).toBe(true);
  });

  it('rejects a qtd smaller than one', async () => {
    const errors = await validatePayload({ ...validPayload, qtd: 0 });

    expect(errors.some((error) => error.property === 'qtd')).toBe(true);
  });

  it('rejects a non-integer qtd', async () => {
    const errors = await validatePayload({ ...validPayload, qtd: 1.5 });

    expect(errors.some((error) => error.property === 'qtd')).toBe(true);
  });

  it('rejects a purchased_at that is not an ISO 8601 date', async () => {
    const errors = await validatePayload({
      ...validPayload,
      purchased_at: '12/07/2026',
    });

    expect(errors.some((error) => error.property === 'purchased_at')).toBe(
      true,
    );
  });
});
