package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"time"

	sudoworklog "github.com/sudowork/sudo-log/sdk/go"
)

func main() {
	tenantID := requiredEnv("SUDO_LOG_TENANT_ID")
	product := requiredEnv("SUDO_LOG_PRODUCT")
	environment := env("SUDO_LOG_ENVIRONMENT", "production")

	client, err := sudoworklog.NewClient(sudoworklog.Config{
		BaseURL:     requiredEnv("SUDO_LOG_BASE_URL"),
		APIKey:      requiredEnv("SUDO_LOG_API_KEY"),
		TenantID:    tenantID,
		Product:     product,
		Environment: environment,
		DefaultTags: map[string]any{
			"sdk":    "go",
			"source": "sdk-example",
		},
		DefaultAttributes: map[string]any{
			"sdk_language": "go",
			"example":      "batch-all-fields",
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	now := time.Now().UTC()
	logs := []sudoworklog.LogEvent{
		{
			Timestamp:          now.Format(time.RFC3339Nano),
			TenantID:           tenantID,
			Product:            product,
			Topic:              "error",
			Environment:        environment,
			Level:              "error",
			Component:          "GoSdkExample",
			Version:            "1.2.3-go",
			Platform:           "linux",
			Arch:               "amd64",
			LoginMode:          "oauth",
			UserIdentifier:     "go-user@example.invalid",
			UserIdentifierHash: sha256Hex("go-user@example.invalid"),
			UserID:             "go-user-001",
			UserIDHash:         sha256Hex("go-user-001"),
			DeviceID:           "go-device-001",
			DeviceIDHash:       sha256Hex("go-device-001"),
			SessionID:          "go-session-001",
			ConversationID:     "go-conversation-001",
			TraceID:            "go-trace-001",
			Message:            "go sdk example log covers all batch fields",
			Error: &sudoworklog.ErrorDetail{
				Name:    "GoExampleError",
				Message: "fake go sdk error",
				Stack:   "GoExampleError: fake go sdk error\n    at runExample (/app/src/go_example.go:10)",
			},
			ErrorName:    "GoExampleFallbackError",
			ErrorMessage: "fake go fallback error message",
			StackTrace:   "GoExampleFallbackError: fake fallback stack\n    at fallback (/app/src/go_example.go:20)",
			Tags: map[string]any{
				"feature":  "sdk-example",
				"provider": "fake-provider",
				"plan":     "team",
				"scenario": "all-fields",
			},
			Attributes: map[string]any{
				"route":         "/sdk/go/example",
				"http_status":   504,
				"retryable":     true,
				"order_id":      "fake-go-order-001",
				"payload_shape": map[string]any{"covered": true, "language": "go"},
			},
		},
		{
			Timestamp:      now.Add(-time.Second).Format(time.RFC3339Nano),
			Topic:          "error",
			Level:          "error",
			Component:      "GoSdkExample",
			UserIdentifier: "go-secondary-user@example.invalid",
			Message:        "go sdk secondary error example log",
			Error: &sudoworklog.ErrorDetail{
				Name:    "GoSecondaryExampleError",
				Message: "fake secondary go sdk error",
				Stack:   "GoSecondaryExampleError: fake secondary go sdk error\n    at secondary (/app/src/go_example.go:30)",
			},
			Tags: map[string]any{
				"feature":  "sdk-example",
				"scenario": "secondary-error",
				"provider": "fake-provider",
			},
			Attributes: map[string]any{
				"route":       "/sdk/go/secondary",
				"http_status": 500,
				"cache_hit":   false,
			},
		},
		{
			Timestamp:      now.Add(-2 * time.Second).Format(time.RFC3339Nano),
			Topic:          "error",
			Level:          "error",
			Component:      "GoSdkExample",
			UserIdentifier: "go-tertiary-user@example.invalid",
			Message:        "go sdk tertiary error example log",
			Error: &sudoworklog.ErrorDetail{
				Name:    "GoTertiaryExampleError",
				Message: "fake tertiary go sdk error",
				Stack:   "GoTertiaryExampleError: fake tertiary go sdk error\n    at tertiary (/app/src/go_example.go:40)",
			},
			Tags: map[string]any{
				"feature":  "sdk-example",
				"scenario": "tertiary-error",
				"provider": "fake-provider",
			},
			Attributes: map[string]any{
				"route":        "/sdk/go/tertiary",
				"http_status":  409,
				"warning_code": "fake-conflict",
			},
		},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	response, err := client.SendBatch(ctx, logs)
	if err != nil {
		log.Fatal(err)
	}

	payload, _ := json.MarshalIndent(map[string]any{"language": "go", "response": response}, "", "  ")
	fmt.Println(string(payload))
}

func sha256Hex(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func env(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func requiredEnv(key string) string {
	value := os.Getenv(key)
	if value == "" {
		log.Fatalf("%s is required", key)
	}
	return value
}
