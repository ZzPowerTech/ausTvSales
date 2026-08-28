import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuthModule } from './auth/auth.module';
import { CategoriesModule } from './categories/categories.module';
import { validateEnv } from './config/env.validation';
import { DatabaseModule } from './db/database.module';
import { HealthModule } from './health/health.module';
import { InstrumentationModule } from './instrumentation/instrumentation.module';
import { ItemsModule } from './items/items.module';
import { MetricsModule } from './metrics/metrics.module';
import { TutorialModule } from './tutorial/tutorial.module';
import { SalesModule } from './sales/sales.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    // Raiz UNICA do agendamento, e a unicidade e o ponto. `forRoot()` registra
    // um SchedulerOrchestrator, e cada orchestrator varre o app inteiro pelo
    // DiscoveryModule — chamar duas vezes faz todo @Cron/@Interval disparar em
    // dobro (medido na S8.0, quando um segundo modulo passou a precisar de
    // agendamento). Mesma forma do ThrottlerModule.forRoot() do PR #156, mesma
    // resolucao: uma raiz so, na raiz da composicao.
    ScheduleModule.forRoot(),
    DatabaseModule,
    // AuthModule registers the global deny-by-default guard, so it must be in
    // place before any feature module exposes a route.
    AuthModule,
    HealthModule,
    // Instrumentation health (AusTV Admin S6.3): watches whether the *game
    // network measurement* is still happening. Not to be confused with
    // HealthModule above, which is this process's own liveness probe.
    InstrumentationModule,
    // Leituras normalizadas da rede de jogo (S7.2). Distinto do
    // InstrumentationModule: aquele pergunta "a coleta ainda acontece?" e fala
    // com o Plan sem cache; este publica os numeros e fala com cache na frente.
    MetricsModule,
    // Fonte do funil do tutorial (S8.0, ADR-0004). O Plan nao coleta nada do
    // tutorial, entao este modulo le os arquivos do proprio plugin Quests e e a
    // unica origem de dois dos quatro degraus do funil da secao 6.2.
    TutorialModule,
    CategoriesModule,
    ItemsModule,
    SalesModule,
    AnalyticsModule,
  ],
})
export class AppModule {}
