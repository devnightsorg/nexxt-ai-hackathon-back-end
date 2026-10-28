import { INestApplication, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { config } from './config/config';

/** Shared HTTP setup, also applied by the e2e test app so tests see production behaviour. */
export function configureApp(app: INestApplication): void {
  const { CORS_ORIGIN } = config();
  app.use(helmet());
  app.enableCors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',').map((o) => o.trim()) });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const document = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Raiffeisen Agent API')
      .setDescription('Simulated Raiffeisen Bank România backend: banking, goals, products, AI agent, MCP.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('docs', app, document);
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config().PORT);
}

if (require.main === module) {
  void bootstrap();
}
