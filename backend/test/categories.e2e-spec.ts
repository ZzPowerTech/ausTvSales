import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { App } from 'supertest/types';
import { createAuthenticatedApp } from './e2e-utils';

describe('Categories (e2e)', () => {
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

  it('requires authentication to create a category (401)', () => {
    return http().post('/categories').send({ name: 'Caixas' }).expect(401);
  });

  it('creates and lists a category', async () => {
    const created = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas', display_order: 1 })
      .expect(201);

    expect(created.body).toMatchObject({ name: 'Caixas', displayOrder: 1 });

    const list = await http()
      .get('/categories')
      .set('Cookie', authCookie)
      .expect(200);
    const categories = list.body as Array<{ name: string }>;
    expect(categories).toHaveLength(1);
    expect(categories[0].name).toBe('Caixas');
  });

  it('rejects a duplicate name case-insensitively (409)', async () => {
    await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'caixas' })
      .expect(409);
  });

  it('rejects an empty name (400)', () => {
    return http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: '   ' })
      .expect(400);
  });

  it('updates a category name and order', async () => {
    const created = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    const updated = await http()
      .patch(`/categories/${(created.body as { id: number }).id}`)
      .set('Cookie', authCookie)
      .send({ name: 'Caixas de Natal', display_order: 5 })
      .expect(200);

    expect(updated.body).toMatchObject({
      name: 'Caixas de Natal',
      displayOrder: 5,
    });
  });

  it('rejects a PATCH with no updatable fields (400)', async () => {
    const created = await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    await http()
      .patch(`/categories/${(created.body as { id: number }).id}`)
      .set('Cookie', authCookie)
      .send({})
      .expect(400);
  });

  it('returns 404 when updating a missing category', () => {
    return http()
      .patch('/categories/999')
      .set('Cookie', authCookie)
      .send({ name: 'Ghost' })
      .expect(404);
  });

  describe('atomic reordering (S4.0)', () => {
    /** Create the given names in order, returning their ids. */
    async function seed(...names: string[]): Promise<number[]> {
      const ids: number[] = [];
      for (const name of names) {
        const created = await http()
          .post('/categories')
          .set('Cookie', authCookie)
          .send({ name })
          .expect(201);
        ids.push((created.body as { id: number }).id);
      }
      return ids;
    }

    const listNames = async (): Promise<string[]> => {
      const list = await http()
        .get('/categories')
        .set('Cookie', authCookie)
        .expect(200);
      return (list.body as Array<{ name: string }>).map((c) => c.name);
    };

    it('requires authentication (401)', async () => {
      await http().patch('/categories/reorder').send({ order: [1] }).expect(401);
    });

    it('routes /categories/reorder to the reorder handler, not to :id', async () => {
      // Regression guard: if @Patch('reorder') is ever declared after
      // @Patch(':id'), ParseIntPipe swallows "reorder" and this returns 400.
      const [a, b] = await seed('Alfa', 'Beta');

      await http()
        .patch('/categories/reorder')
        .set('Cookie', authCookie)
        .send({ order: [b, a] })
        .expect(200);
    });

    it('rewrites display_order by position', async () => {
      const [caixas, vip, extras] = await seed('Caixas', 'VIP', 'Extras');

      const reordered = await http()
        .patch('/categories/reorder')
        .set('Cookie', authCookie)
        .send({ order: [vip, extras, caixas] })
        .expect(200);

      expect((reordered.body as Array<{ name: string }>).map((c) => c.name)).toEqual([
        'VIP',
        'Extras',
        'Caixas',
      ]);
      // And the order survives a fresh read.
      await expect(listNames()).resolves.toEqual(['VIP', 'Extras', 'Caixas']);
    });

    it('rejects an unknown id and leaves the order untouched (400)', async () => {
      const [caixas, vip] = await seed('Caixas', 'VIP');

      await http()
        .patch('/categories/reorder')
        .set('Cookie', authCookie)
        .send({ order: [vip, caixas, 9999] })
        .expect(400);

      // No partial write: creation order (display_order 0 for both, then name)
      // is intact.
      await expect(listNames()).resolves.toEqual(['Caixas', 'VIP']);
    });

    it('rejects an incomplete set (400)', async () => {
      const [caixas] = await seed('Caixas', 'VIP');

      await http()
        .patch('/categories/reorder')
        .set('Cookie', authCookie)
        .send({ order: [caixas] })
        .expect(400);

      await expect(listNames()).resolves.toEqual(['Caixas', 'VIP']);
    });

    it('rejects a duplicated id (400)', async () => {
      const [caixas] = await seed('Caixas', 'VIP');

      await http()
        .patch('/categories/reorder')
        .set('Cookie', authCookie)
        .send({ order: [caixas, caixas] })
        .expect(400);
    });

    it('rejects an empty order (400)', async () => {
      await seed('Caixas');

      await http()
        .patch('/categories/reorder')
        .set('Cookie', authCookie)
        .send({ order: [] })
        .expect(400);
    });
  });

  it('enforces case-insensitive uniqueness at the database level', async () => {
    await http()
      .post('/categories')
      .set('Cookie', authCookie)
      .send({ name: 'Caixas' })
      .expect(201);

    // Bypass the service pre-check entirely: the index is the real guarantee.
    await expect(
      pool.query("INSERT INTO categories (name) VALUES ('CAIXAS')"),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
