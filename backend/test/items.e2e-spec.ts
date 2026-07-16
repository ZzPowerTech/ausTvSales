import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

describe('Items (e2e)', () => {
  let app: INestApplication<App>;
  let authCookie: string;
  let pool: Pool;

  beforeAll(async () => {
    ({ app, authCookie } = await createAuthenticatedApp());
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  });

  beforeEach(async () => {
    await pool.query(
      'TRUNCATE sales, items, players, categories RESTART IDENTITY CASCADE',
    );
  });

  afterAll(async () => {
    await pool.end();
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function createCategory(name = 'Caixas'): Promise<number> {
    const response = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name })
      .expect(201);
    return (response.body as { id: number }).id;
  }

  it('requires authentication to create an item (401)', () => {
    return http()
      .post('/items')
      .send({ item_id: 'caixaNatal2026', display_name: 'X', category_id: 1 })
      .expect(401);
  });

  it('creates an item under an existing category', async () => {
    const categoryId = await createCategory();

    const created = await http()
      .post('/items')
      .set('Cookie', authCookie)
      .send({
        item_id: 'caixaNatal2026',
        display_name: 'Caixa de Natal 2026',
        category_id: categoryId,
      })
      .expect(201);

    expect(created.body).toMatchObject({
      itemId: 'caixaNatal2026',
      displayName: 'Caixa de Natal 2026',
      categoryId,
      active: true,
    });
  });

  it('rejects an item for a non-existent category (422)', () => {
    return http()
      .post('/items')
      .set('Cookie', authCookie)
      .send({
        item_id: 'caixaNatal2026',
        display_name: 'Caixa',
        category_id: 4242,
      })
      .expect(422);
  });

  it('rejects an item_id with spaces (400)', async () => {
    const categoryId = await createCategory();
    return http()
      .post('/items')
      .set('Cookie', authCookie)
      .send({
        item_id: 'caixa natal',
        display_name: 'Caixa',
        category_id: categoryId,
      })
      .expect(400);
  });

  it('rejects a duplicate item_id (409)', async () => {
    const categoryId = await createCategory();
    const payload = {
      item_id: 'caixaNatal2026',
      display_name: 'Caixa',
      category_id: categoryId,
    };
    await http()
      .post('/items')
      .set('Cookie', authCookie)
      .send(payload)
      .expect(201);
    await http()
      .post('/items')
      .set('Cookie', authCookie)
      .send(payload)
      .expect(409);
  });

  it('deactivates an item via PATCH instead of deleting it', async () => {
    const categoryId = await createCategory();
    const created = await http()
      .post('/items')
      .set('Cookie', authCookie)
      .send({
        item_id: 'caixaNatal2026',
        display_name: 'Caixa',
        category_id: categoryId,
      })
      .expect(201);

    const itemId = (created.body as { id: number }).id;
    const updated = await http()
      .patch(`/items/${itemId}`)
      .set('Cookie', authCookie)
      .send({ active: false })
      .expect(200);

    expect((updated.body as { active: boolean }).active).toBe(false);
  });

  it('forbids sending item_id on update (immutable, 400)', async () => {
    const categoryId = await createCategory();
    const created = await http()
      .post('/items')
      .set('Cookie', authCookie)
      .send({
        item_id: 'caixaNatal2026',
        display_name: 'Caixa',
        category_id: categoryId,
      })
      .expect(201);

    const itemId = (created.body as { id: number }).id;
    // item_id is not a field on UpdateItemDto and the global pipe forbids
    // non-whitelisted properties, so any attempt to mutate it is rejected.
    await http()
      .patch(`/items/${itemId}`)
      .set('Cookie', authCookie)
      .send({ item_id: 'hacked' })
      .expect(400);

    // A legitimate update leaves the immutable item_id untouched.
    const updated = await http()
      .patch(`/items/${itemId}`)
      .set('Cookie', authCookie)
      .send({ display_name: 'Renamed' })
      .expect(200);
    const body = updated.body as { itemId: string; displayName: string };
    expect(body.itemId).toBe('caixaNatal2026');
    expect(body.displayName).toBe('Renamed');
  });
});
