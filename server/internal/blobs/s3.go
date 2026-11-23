package blobs

import (
	"context"
	"fmt"
	"io"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

// S3Config configures an S3-compatible BlobStore (TEZCA_S3_* env vars).
type S3Config struct {
	Endpoint  string // host[:port]
	AccessKey string
	SecretKey string
	Region    string // optional
	Bucket    string
	Prefix    string // optional key prefix, e.g. "tezca/"
	Insecure  bool   // plain HTTP
}

// s3PartSize bounds memory per upload: bodies are streamed with unknown length (the signature
// is only checked at EOF), so minio-go buffers one part at a time.
const s3PartSize = 16 << 20

// S3 stores blobs as objects <prefix>blobs/<space_id>/<blob_id>.
type S3 struct {
	c      *minio.Client
	bucket string
	prefix string
}

// NewS3 returns an S3 BlobStore. It doesn't contact the server; call Check for that.
func NewS3(cfg S3Config) (*S3, error) {
	if cfg.Endpoint == "" || cfg.Bucket == "" {
		return nil, fmt.Errorf("s3: endpoint and bucket are required")
	}
	c, err := minio.New(cfg.Endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""),
		Secure: !cfg.Insecure,
		Region: cfg.Region,
	})
	if err != nil {
		return nil, fmt.Errorf("s3: %w", err)
	}
	return &S3{c: c, bucket: cfg.Bucket, prefix: cfg.Prefix}, nil
}

// Check verifies that the bucket exists and the credentials work.
func (s *S3) Check(ctx context.Context) error {
	ok, err := s.c.BucketExists(ctx, s.bucket)
	if err != nil {
		return fmt.Errorf("s3: bucket %q: %w", s.bucket, err)
	}
	if !ok {
		return fmt.Errorf("s3: bucket %q does not exist", s.bucket)
	}
	return nil
}

func (s *S3) key(spaceID, blobID string) string {
	return s.prefix + "blobs/" + spaceID + "/" + blobID
}

// Put streams r with unknown length. minio-go reads to EOF before completing the upload and
// aborts it if r fails, which is the BlobStore contract.
func (s *S3) Put(ctx context.Context, spaceID, blobID string, r io.Reader) error {
	if !validKey(spaceID, blobID) {
		return errBadKey
	}
	_, err := s.c.PutObject(ctx, s.bucket, s.key(spaceID, blobID), r, -1, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
		PartSize:    s3PartSize,
	})
	return err
}

// Get returns the object's body and size.
func (s *S3) Get(ctx context.Context, spaceID, blobID string) (io.ReadCloser, int64, error) {
	if !validKey(spaceID, blobID) {
		return nil, 0, ErrNotFound
	}
	obj, err := s.c.GetObject(ctx, s.bucket, s.key(spaceID, blobID), minio.GetObjectOptions{})
	if err != nil {
		return nil, 0, notFound(err)
	}
	st, err := obj.Stat()
	if err != nil {
		obj.Close()
		return nil, 0, notFound(err)
	}
	return obj, st.Size, nil
}

// Exists stats the object.
func (s *S3) Exists(ctx context.Context, spaceID, blobID string) (bool, error) {
	if !validKey(spaceID, blobID) {
		return false, nil
	}
	_, err := s.c.StatObject(ctx, s.bucket, s.key(spaceID, blobID), minio.StatObjectOptions{})
	if err == nil {
		return true, nil
	}
	if notFound(err) == ErrNotFound {
		return false, nil
	}
	return false, err
}

func notFound(err error) error {
	switch minio.ToErrorResponse(err).Code {
	case minio.NoSuchKey, "NotFound":
		return ErrNotFound
	}
	return err
}

// Delete removes the object (S3 deletes of missing keys succeed).
func (s *S3) Delete(ctx context.Context, spaceID, blobID string) error {
	if !validKey(spaceID, blobID) {
		return errBadKey
	}
	return s.c.RemoveObject(ctx, s.bucket, s.key(spaceID, blobID), minio.RemoveObjectOptions{})
}
