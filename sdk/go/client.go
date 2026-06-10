package sudoworklog

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	defaultAPIKeyHeader = "X-API-Key"
	defaultEnvironment  = "production"
	defaultMaxRetries   = 2
	maxBatchSize        = 50
)

type Config struct {
	BaseURL           string
	APIKey            string
	TenantID          string
	Product           string
	Environment       string
	APIKeyHeader      string
	HTTPClient        *http.Client
	MaxRetries        int
	DefaultTags       map[string]any
	DefaultAttributes map[string]any
}

type Client struct {
	baseURL           string
	apiKey            string
	tenantID          string
	product           string
	environment       string
	apiKeyHeader      string
	httpClient        *http.Client
	maxRetries        int
	defaultTags       map[string]any
	defaultAttributes map[string]any
}

type ErrorDetail struct {
	Name    string `json:"name,omitempty"`
	Message string `json:"message,omitempty"`
	Stack   string `json:"stack,omitempty"`
}

type LogEvent struct {
	Timestamp          any            `json:"timestamp,omitempty"`
	TenantID           string         `json:"tenant_id,omitempty"`
	Product            string         `json:"product,omitempty"`
	Topic              string         `json:"topic,omitempty"`
	Environment        string         `json:"environment,omitempty"`
	Level              string         `json:"level,omitempty"`
	Component          string         `json:"component,omitempty"`
	Version            string         `json:"version,omitempty"`
	Platform           string         `json:"platform,omitempty"`
	Arch               string         `json:"arch,omitempty"`
	LoginMode          string         `json:"login_mode,omitempty"`
	UserIdentifier     string         `json:"user_identifier,omitempty"`
	UserIdentifierHash string         `json:"user_identifier_hash,omitempty"`
	UserID             string         `json:"user_id,omitempty"`
	UserIDHash         string         `json:"user_id_hash,omitempty"`
	DeviceID           string         `json:"device_id,omitempty"`
	DeviceIDHash       string         `json:"device_id_hash,omitempty"`
	SessionID          string         `json:"session_id,omitempty"`
	ConversationID     string         `json:"conversation_id,omitempty"`
	TraceID            string         `json:"trace_id,omitempty"`
	Message            string         `json:"message,omitempty"`
	Error              *ErrorDetail   `json:"error,omitempty"`
	ErrorName          string         `json:"error_name,omitempty"`
	ErrorMessage       string         `json:"error_message,omitempty"`
	StackTrace         string         `json:"stack_trace,omitempty"`
	Tags               map[string]any `json:"tags,omitempty"`
	Attributes         map[string]any `json:"attributes,omitempty"`
}

type BatchResponse struct {
	Success  bool     `json:"success"`
	Accepted bool     `json:"accepted,omitempty"`
	Received int      `json:"received,omitempty"`
	EventIDs []string `json:"event_ids,omitempty"`
	Error    string   `json:"error,omitempty"`
}

type RequestError struct {
	StatusCode int
	Body       []byte
	Message    string
}

func (e *RequestError) Error() string {
	if e.Message != "" {
		return e.Message
	}
	if e.StatusCode > 0 {
		return fmt.Sprintf("sudowork log request failed with %d", e.StatusCode)
	}
	return "sudowork log request failed"
}

func NewClient(config Config) (*Client, error) {
	baseURL := strings.TrimRight(config.BaseURL, "/")
	if baseURL == "" {
		return nil, errors.New("baseURL is required")
	}
	if config.APIKey == "" {
		return nil, errors.New("apiKey is required")
	}
	if config.TenantID == "" {
		return nil, errors.New("tenantID is required")
	}
	if config.Product == "" {
		return nil, errors.New("product is required")
	}

	httpClient := config.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 5 * time.Second}
	}

	environment := config.Environment
	if environment == "" {
		environment = defaultEnvironment
	}
	apiKeyHeader := config.APIKeyHeader
	if apiKeyHeader == "" {
		apiKeyHeader = defaultAPIKeyHeader
	}
	maxRetries := defaultMaxRetries
	if config.MaxRetries > 0 {
		maxRetries = config.MaxRetries
	}
	if config.MaxRetries < 0 {
		maxRetries = 0
	}

	return &Client{
		baseURL:           baseURL,
		apiKey:            config.APIKey,
		tenantID:          config.TenantID,
		product:           config.Product,
		environment:       environment,
		apiKeyHeader:      apiKeyHeader,
		httpClient:        httpClient,
		maxRetries:        maxRetries,
		defaultTags:       cloneMap(config.DefaultTags),
		defaultAttributes: cloneMap(config.DefaultAttributes),
	}, nil
}

func (c *Client) Endpoint() string {
	return c.baseURL + "/v1/logs/batch"
}

func (c *Client) SendBatch(ctx context.Context, logs []LogEvent) (*BatchResponse, error) {
	if len(logs) == 0 {
		return nil, errors.New("logs must not be empty")
	}
	if len(logs) > maxBatchSize {
		return nil, fmt.Errorf("logs must contain no more than %d entries", maxBatchSize)
	}

	withDefaults := make([]LogEvent, 0, len(logs))
	for _, log := range logs {
		normalized, err := c.withDefaults(log)
		if err != nil {
			return nil, err
		}
		withDefaults = append(withDefaults, normalized)
	}

	payload, err := json.Marshal(map[string]any{"logs": withDefaults})
	if err != nil {
		return nil, err
	}

	var lastErr error
	for attempt := 0; attempt <= c.maxRetries; attempt++ {
		response, err := c.do(ctx, payload)
		if err == nil {
			return response, nil
		}
		lastErr = err
		var requestErr *RequestError
		if errors.As(err, &requestErr) && !isRetryableStatus(requestErr.StatusCode) {
			return nil, err
		}
		if attempt < c.maxRetries {
			if err := sleep(ctx, 200*time.Millisecond*time.Duration(1<<attempt)); err != nil {
				return nil, err
			}
		}
	}
	return nil, lastErr
}

func (c *Client) Log(ctx context.Context, log LogEvent) (*BatchResponse, error) {
	return c.SendBatch(ctx, []LogEvent{log})
}

func (c *Client) withDefaults(log LogEvent) (LogEvent, error) {
	if log.TenantID != "" && log.TenantID != c.tenantID {
		return LogEvent{}, fmt.Errorf("log tenant_id does not match client tenantID: %s", log.TenantID)
	}
	if log.Product != "" && log.Product != c.product {
		return LogEvent{}, fmt.Errorf("log product does not match client product: %s", log.Product)
	}
	log.TenantID = c.tenantID
	log.Product = c.product
	if log.Environment == "" {
		log.Environment = c.environment
	}
	log.Tags = mergeMap(c.defaultTags, log.Tags)
	log.Attributes = mergeMap(c.defaultAttributes, log.Attributes)
	return log, nil
}

func (c *Client) do(ctx context.Context, payload []byte) (*BatchResponse, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, c.Endpoint(), bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set(c.apiKeyHeader, c.apiKey)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, err
	}

	var parsed BatchResponse
	if len(body) > 0 {
		if err := json.Unmarshal(body, &parsed); err != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
			return nil, err
		} else if err != nil {
			parsed.Error = string(body)
		}
	}

	if response.StatusCode < 200 || response.StatusCode >= 300 || !parsed.Success {
		message := parsed.Error
		if message == "" {
			message = fmt.Sprintf("sudowork log request failed with %d", response.StatusCode)
		}
		return nil, &RequestError{StatusCode: response.StatusCode, Body: body, Message: message}
	}

	return &parsed, nil
}

func cloneMap(values map[string]any) map[string]any {
	if len(values) == 0 {
		return nil
	}
	result := make(map[string]any, len(values))
	for key, value := range values {
		result[key] = value
	}
	return result
}

func mergeMap(left, right map[string]any) map[string]any {
	if len(left) == 0 && len(right) == 0 {
		return nil
	}
	result := make(map[string]any, len(left)+len(right))
	for key, value := range left {
		result[key] = value
	}
	for key, value := range right {
		result[key] = value
	}
	return result
}

func isRetryableStatus(status int) bool {
	return status >= 500 && status <= 599
}

func sleep(ctx context.Context, duration time.Duration) error {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
