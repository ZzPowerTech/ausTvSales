plugins {
    id("java")
}

group = "de.austv.sales"
version = "0.6.0" // x-release-please-version

java {
    toolchain {
        languageVersion.set(JavaLanguageVersion.of(21))
    }
}

repositories {
    mavenCentral()
    maven("https://repo.papermc.io/repository/maven-public/")
}

dependencies {
    compileOnly("io.papermc.paper:paper-api:1.21.4-R0.1-SNAPSHOT")

    // Gson para parsear a API de Releases do GitHub no auto-update.
    // compileOnly: o Paper ja fornece o Gson no classpath em runtime.
    compileOnly("com.google.code.gson:gson:2.11.0")

    // Fila de fallback (S3.2): o driver e distribuido via plugin.yml `libraries:` (Paper baixa
    // e disponibiliza em runtime), entao aqui e compileOnly - nao vai empacotado no jar do plugin.
    compileOnly("org.xerial:sqlite-jdbc:3.47.1.0")

    testImplementation(platform("org.junit:junit-bom:5.11.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")

    // Gson e compileOnly no main (o Paper o fornece em runtime); nos testes da serializacao
    // pura de payload precisamos dele no classpath de teste.
    testImplementation("com.google.code.gson:gson:2.11.0")

    // sqlite-jdbc e compileOnly no main (Paper fornece via `libraries:` em runtime); os testes de
    // SaleQueue precisam do driver de verdade no classpath para exercitar o SQLite real.
    testImplementation("org.xerial:sqlite-jdbc:3.47.1.0")
}

tasks.withType<JavaCompile> {
    options.encoding = "UTF-8"
    options.compilerArgs.add("-Xlint:deprecation")
    options.release.set(21)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
    }
}

tasks.processResources {
    filteringCharset = "UTF-8"
    val props = mapOf("version" to version)
    inputs.properties(props)
    filesMatching("plugin.yml") {
        expand(props)
    }
}
