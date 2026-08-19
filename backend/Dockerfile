# --- Build stage: compile the fat jar with Maven ---
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app

# Cache dependency resolution in its own layer — only re-runs when pom.xml changes.
COPY pom.xml .
RUN mvn -B -q dependency:go-offline

COPY src ./src
RUN mvn -B -q package -DskipTests

# --- Runtime stage: just the JRE + the jar, no build tooling ---
FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
