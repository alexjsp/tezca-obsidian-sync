package ws

import (
	"context"
	"encoding/base64"
	"errors"

	"google.golang.org/protobuf/proto"

	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
)

type reqErr struct {
	code pb.ErrorCode
	msg  string
}

func (e *reqErr) Error() string { return e.msg }

func rerr(code pb.ErrorCode, msg string) error { return &reqErr{code, msg} }

var (
	errForbidden = rerr(pb.ErrorCode_ERROR_CODE_FORBIDDEN, "forbidden")
	errNotMember = rerr(pb.ErrorCode_ERROR_CODE_FORBIDDEN, "not a member of this space")
	errBadID     = rerr(pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "invalid space_id or doc_id")
)

// fail converts err to an Error frame.
func (c *conn) fail(rid uint32, space, doc string, err error) {
	var re *reqErr
	switch {
	case errors.As(err, &re):
		c.send(errFrame(rid, re.code, re.msg, space, doc))
	case errors.Is(err, store.ErrEpochStale):
		c.send(errFrame(rid, pb.ErrorCode_ERROR_CODE_EPOCH_STALE, "epoch stale", space, doc))
	case errors.Is(err, store.ErrConflict):
		c.send(errFrame(rid, pb.ErrorCode_ERROR_CODE_CONFLICT, "conflict", space, doc))
	case errors.Is(err, store.ErrNotFound):
		c.send(errFrame(rid, pb.ErrorCode_ERROR_CODE_NOT_FOUND, "not found", space, doc))
	default:
		c.h.log.Error("request failed", "err", err, "space", space, "doc", doc)
		c.send(errFrame(rid, pb.ErrorCode_ERROR_CODE_INTERNAL, "internal error", space, doc))
	}
}

func (c *conn) dispatch(ctx context.Context, f *pb.ClientFrame) {
	switch m := f.Msg.(type) {
	case *pb.ClientFrame_Ping:
		c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_Pong{Pong: &pb.Pong{T: m.Ping.T}}})
	case *pb.ClientFrame_ListSpaces:
		c.listSpaces(ctx, m.ListSpaces)
	case *pb.ClientFrame_CreateSpace:
		c.createSpace(ctx, m.CreateSpace)
	case *pb.ClientFrame_SubscribeSpace:
		s := m.SubscribeSpace.SpaceId
		if err := c.subscribeSpace(ctx, s); err != nil {
			c.fail(0, s, "", err)
		}
	case *pb.ClientFrame_UnsubscribeSpace:
		s := m.UnsubscribeSpace.SpaceId
		if _, ok := c.spaceSubs[s]; ok {
			delete(c.spaceSubs, s)
			c.h.unsubscribeSpace(c, s)
		}
	case *pb.ClientFrame_Subscribe:
		s := m.Subscribe
		if err := c.subscribe(ctx, s); err != nil {
			c.fail(0, s.SpaceId, s.DocId, err)
		}
	case *pb.ClientFrame_Unsubscribe:
		k := docKey{m.Unsubscribe.SpaceId, m.Unsubscribe.DocId}
		if _, ok := c.docSubs[k]; ok {
			delete(c.docSubs, k)
			c.h.withDoc(k.space, k.doc, func(ds *docState) { c.h.removeSub(ds, c) })
		}
	case *pb.ClientFrame_PushUpdate:
		p := m.PushUpdate
		if err := c.pushUpdate(ctx, p); err != nil {
			c.fail(p.Ref, p.SpaceId, p.DocId, err)
		}
	case *pb.ClientFrame_PutSnapshot:
		p := m.PutSnapshot
		if err := c.putSnapshot(ctx, p); err != nil {
			c.fail(p.Ref, p.SpaceId, p.DocId, err)
		}
	case *pb.ClientFrame_ListVersions:
		v := m.ListVersions
		if err := c.listVersions(ctx, v); err != nil {
			c.fail(v.Rid, v.SpaceId, v.DocId, err)
		}
	case *pb.ClientFrame_GetVersion:
		v := m.GetVersion
		if err := c.getVersion(ctx, v); err != nil {
			c.fail(v.Rid, v.SpaceId, v.DocId, err)
		}
	case *pb.ClientFrame_Awareness:
		a := m.Awareness
		if err := c.awareness(ctx, a); err != nil {
			c.fail(0, a.SpaceId, a.DocId, err)
		}
	case *pb.ClientFrame_Hello, *pb.ClientFrame_Auth:
		c.send(errFrame(0, pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "already authenticated", "", ""))
	default:
		c.send(errFrame(0, pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "unknown frame", "", ""))
	}
}

func spaceInfo(s store.Space) *pb.SpaceInfo {
	si := &pb.SpaceInfo{
		SpaceId: s.SpaceID, Kind: pb.SpaceKind(s.Kind), Role: pb.SpaceRole(s.Role), Epoch: s.Epoch,
		Meta: s.Meta, MetaEpoch: s.MetaEpoch,
	}
	for _, k := range s.Keys {
		si.Keys = append(si.Keys, &pb.SpaceKey{Epoch: k.Epoch, Wrapped: k.Wrapped})
	}
	for _, m := range s.Members {
		si.Members = append(si.Members, &pb.Member{SignPk: m.SignPk, BoxPk: m.BoxPk, Role: pb.SpaceRole(m.Role)})
	}
	return si
}

func (c *conn) listSpaces(ctx context.Context, m *pb.ListSpaces) {
	spaces, err := c.h.cfg.Store.ListSpaces(ctx, c.user.SignPk)
	if err != nil {
		c.fail(m.Rid, "", "", err)
		return
	}
	out := &pb.SpaceList{Rid: m.Rid, Spaces: make([]*pb.SpaceInfo, 0, len(spaces))}
	for _, s := range spaces {
		out.Spaces = append(out.Spaces, spaceInfo(s))
	}
	c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_SpaceList{SpaceList: out}})
}

// validSpaceID: 16 bytes as unpadded base64url (22 chars).
func validSpaceID(id string) bool {
	if len(id) != 22 {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(id)
	return err == nil && len(b) == 16
}

func (c *conn) createSpace(ctx context.Context, m *pb.CreateSpace) {
	err := func() error {
		if !validSpaceID(m.SpaceId) {
			return rerr(pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "space_id must be 16 bytes base64url")
		}
		if _, ok := pb.SpaceKind_name[int32(m.Kind)]; !ok || m.Kind == pb.SpaceKind_SPACE_KIND_UNSPECIFIED {
			return rerr(pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "invalid kind")
		}
		// Guests (M4) may only create their one PROFILE space (the store refuses a second).
		if c.user.Role != store.HostAdmin && c.user.Role != store.HostMember && m.Kind != pb.SpaceKind_SPACE_KIND_PROFILE {
			return rerr(pb.ErrorCode_ERROR_CODE_FORBIDDEN, "guests can only create a profile space")
		}
		if len(m.WrappedKey) == 0 || len(m.WrappedKey) > MaxWrappedKey {
			return rerr(pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "invalid wrapped_key")
		}
		if len(m.Meta) > MaxMeta {
			return rerr(pb.ErrorCode_ERROR_CODE_TOO_LARGE, "meta too large")
		}
		if err := c.h.cfg.Store.CreateSpace(ctx, m.SpaceId, int(m.Kind), c.user.SignPk, m.WrappedKey, m.Meta, c.h.cfg.Now().UnixMilli()); err != nil {
			return err
		}
		sp, err := c.h.cfg.Store.GetSpace(ctx, m.SpaceId, c.user.SignPk)
		if err != nil {
			return err
		}
		c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_SpaceCreated{SpaceCreated: &pb.SpaceCreated{Rid: m.Rid, Space: spaceInfo(sp)}}})
		return nil
	}()
	if err != nil {
		c.fail(m.Rid, m.SpaceId, "", err)
	}
}

func (c *conn) membership(ctx context.Context, space string) (role int, epoch uint32, err error) {
	role, epoch, err = c.h.cfg.Store.Membership(ctx, space, c.user.SignPk)
	if errors.Is(err, store.ErrNotFound) {
		err = errNotMember
	}
	return
}

func (c *conn) subscribeSpace(ctx context.Context, space string) error {
	if !store.ValidID(space) {
		return errBadID
	}
	if err := c.h.subscribeSpace(ctx, c, space); err != nil { // checks membership under the feed lock
		return err
	}
	c.spaceSubs[space] = struct{}{}
	return nil
}

func (c *conn) subscribe(ctx context.Context, m *pb.Subscribe) error {
	if !store.ValidID(m.SpaceId) || !store.ValidID(m.DocId) {
		return errBadID
	}
	var opErr error
	c.h.withDoc(m.SpaceId, m.DocId, func(ds *docState) {
		// Membership is checked under the doc lock so EvictMember can't miss this subscription.
		if _, _, opErr = c.membership(ctx, m.SpaceId); opErr != nil {
			return
		}
		opErr = c.sendBacklog(ctx, m.SpaceId, m.DocId, m.SinceSeq)
		if opErr == nil {
			c.h.addSub(ds, c)
			c.docSubs[docKey{m.SpaceId, m.DocId}] = struct{}{}
		}
	})
	return opErr
}

// sendBacklog enqueues Snapshot? → Updates* → SyncDone. Caller holds the doc lock.
func (c *conn) sendBacklog(ctx context.Context, space, doc string, since uint64) error {
	st := c.h.cfg.Store
	d, err := st.GetDoc(ctx, space, doc)
	if err != nil {
		return err
	}
	from := since
	if d.SnapshotSeq > since {
		sn, err := st.LatestSnapshot(ctx, space, doc)
		if err != nil {
			return err
		}
		c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_Snapshot{Snapshot: &pb.Snapshot{
			SpaceId: space, DocId: doc, BaseSeq: sn.BaseSeq, Epoch: sn.Epoch, Author: sn.Author, Payload: sn.Payload, Sig: sn.Sig,
		}}})
		from = sn.BaseSeq
	}
	err = st.StreamUpdates(ctx, space, doc, from, BatchMaxUpdates, BatchMaxBytes, func(batch []store.Update) error {
		c.send(updatesFrame(space, doc, batch))
		select {
		case <-c.dead:
			return context.Canceled
		default:
			return nil
		}
	})
	if err != nil {
		return err
	}
	c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_SyncDone{SyncDone: &pb.SyncDone{
		SpaceId: space, DocId: doc, LatestSeq: d.LatestSeq,
		UpdatesSinceSnapshot: d.UpdatesSinceSnapshot, BytesSinceSnapshot: d.BytesSinceSnapshot,
		SnapshotCreatedAt: d.SnapshotCreatedAt,
	}}})
	return nil
}

func updatesFrame(space, doc string, us []store.Update) *pb.ServerFrame {
	out := &pb.Updates{SpaceId: space, DocId: doc, Updates: make([]*pb.Update, len(us))}
	for i, u := range us {
		out.Updates[i] = &pb.Update{Seq: u.Seq, Epoch: u.Epoch, Author: u.Author, Payload: u.Payload, Sig: u.Sig}
	}
	return &pb.ServerFrame{Msg: &pb.ServerFrame_Updates{Updates: out}}
}

func headsFrame(d store.Doc) []byte {
	b, _ := proto.Marshal(&pb.ServerFrame{Msg: &pb.ServerFrame_DocHeads{DocHeads: &pb.DocHeads{
		SpaceId: d.SpaceID, Full: false,
		Heads: []*pb.DocHead{{DocId: d.DocID, LatestSeq: d.LatestSeq, SnapshotSeq: d.SnapshotSeq}},
	}}})
	return b
}

// checkWrite applies the role and epoch checks shared by PushUpdate and PutSnapshot.
func (c *conn) checkWrite(ctx context.Context, space, doc string, epoch uint32) error {
	if !store.ValidID(space) || !store.ValidID(doc) {
		return errBadID
	}
	role, cur, err := c.membership(ctx, space)
	if err != nil {
		return err
	}
	if role != store.SpaceOwner && role != store.SpaceEditor {
		return rerr(pb.ErrorCode_ERROR_CODE_FORBIDDEN, "read-only member")
	}
	if epoch != cur {
		return store.ErrEpochStale
	}
	return nil
}

func (c *conn) pushUpdate(ctx context.Context, m *pb.PushUpdate) error {
	if len(m.Payload) > MaxUpdate {
		return rerr(pb.ErrorCode_ERROR_CODE_TOO_LARGE, "update exceeds 4 MiB")
	}
	if err := c.checkWrite(ctx, m.SpaceId, m.DocId, m.Epoch); err != nil {
		return err
	}
	if !sigs.Verify(c.user.SignPk, sigs.Update(m.SpaceId, m.DocId, m.Epoch, m.Payload), m.Sig) {
		return rerr(pb.ErrorCode_ERROR_CODE_UNAUTHORIZED, "bad signature")
	}
	var opErr error
	c.h.withDoc(m.SpaceId, m.DocId, func(ds *docState) {
		u := store.Update{Epoch: m.Epoch, Author: c.user.SignPk, Payload: m.Payload, Sig: m.Sig}
		d, err := c.h.cfg.Store.AppendUpdate(ctx, m.SpaceId, m.DocId, u)
		if err != nil {
			opErr = err
			return
		}
		u.Seq = d.LatestSeq
		c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_Ack{Ack: &pb.Ack{Ref: m.Ref, SpaceId: m.SpaceId, DocId: m.DocId, Seq: u.Seq}}})
		if len(ds.subs) > 0 {
			b, _ := proto.Marshal(updatesFrame(m.SpaceId, m.DocId, []store.Update{u}))
			for sub := range ds.subs {
				if sub != c {
					sub.sendRaw(b)
				}
			}
		}
		c.h.broadcastHeads(m.SpaceId, headsFrame(d))
	})
	return opErr
}

func (c *conn) putSnapshot(ctx context.Context, m *pb.PutSnapshot) error {
	if len(m.Payload) > MaxSnapshot {
		return rerr(pb.ErrorCode_ERROR_CODE_TOO_LARGE, "snapshot exceeds 16 MiB")
	}
	if err := c.checkWrite(ctx, m.SpaceId, m.DocId, m.Epoch); err != nil {
		return err
	}
	if !sigs.Verify(c.user.SignPk, sigs.Snapshot(m.SpaceId, m.DocId, m.BaseSeq, m.Epoch, m.Payload), m.Sig) {
		return rerr(pb.ErrorCode_ERROR_CODE_UNAUTHORIZED, "bad signature")
	}
	var opErr error
	c.h.withDoc(m.SpaceId, m.DocId, func(ds *docState) {
		sn := store.Snapshot{BaseSeq: m.BaseSeq, Epoch: m.Epoch, Author: c.user.SignPk, Payload: m.Payload, Sig: m.Sig}
		d, err := c.h.cfg.Store.PutSnapshot(ctx, m.SpaceId, m.DocId, sn, c.h.cfg.Now().UnixMilli())
		if err != nil {
			opErr = err
			return
		}
		c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_SnapshotAck{SnapshotAck: &pb.SnapshotAck{
			Ref: m.Ref, SpaceId: m.SpaceId, DocId: m.DocId, BaseSeq: m.BaseSeq, CreatedAt: d.SnapshotCreatedAt,
		}}})
		c.h.broadcastHeads(m.SpaceId, headsFrame(d))
	})
	return opErr
}

// checkRead applies the id and membership checks shared by read-only doc requests.
func (c *conn) checkRead(ctx context.Context, space, doc string) error {
	if !store.ValidID(space) || !store.ValidID(doc) {
		return errBadID
	}
	_, _, err := c.membership(ctx, space)
	return err
}

func versionInfo(v store.Version) *pb.VersionInfo {
	return &pb.VersionInfo{BaseSeq: v.BaseSeq, CreatedAt: v.CreatedAt, Author: v.Author, Size: v.Size, Epoch: v.Epoch}
}

func (c *conn) listVersions(ctx context.Context, m *pb.ListVersions) error {
	if err := c.checkRead(ctx, m.SpaceId, m.DocId); err != nil {
		return err
	}
	vs, err := c.h.cfg.Store.ListVersions(ctx, m.SpaceId, m.DocId)
	if err != nil {
		return err
	}
	out := &pb.VersionList{Rid: m.Rid, SpaceId: m.SpaceId, DocId: m.DocId, Versions: make([]*pb.VersionInfo, len(vs))}
	for i, v := range vs {
		out.Versions[i] = versionInfo(v)
	}
	c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_VersionList{VersionList: out}})
	return nil
}

func (c *conn) getVersion(ctx context.Context, m *pb.GetVersion) error {
	if err := c.checkRead(ctx, m.SpaceId, m.DocId); err != nil {
		return err
	}
	sn, err := c.h.cfg.Store.GetVersion(ctx, m.SpaceId, m.DocId, m.BaseSeq)
	if err != nil {
		return err // ErrNotFound → NOT_FOUND
	}
	info := versionInfo(store.Version{BaseSeq: sn.BaseSeq, CreatedAt: sn.CreatedAt, Author: sn.Author, Size: uint64(len(sn.Payload)), Epoch: sn.Epoch})
	c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_VersionData{VersionData: &pb.VersionData{
		Rid: m.Rid, SpaceId: m.SpaceId, DocId: m.DocId, Info: info, Payload: sn.Payload, Sig: sn.Sig,
	}}})
	return nil
}

func (c *conn) awareness(ctx context.Context, m *pb.AwarenessIn) error {
	if len(m.Payload) > MaxAwareness {
		return rerr(pb.ErrorCode_ERROR_CODE_TOO_LARGE, "awareness exceeds 64 KiB")
	}
	if !store.ValidID(m.SpaceId) || !store.ValidID(m.DocId) {
		return errBadID
	}
	if _, _, err := c.membership(ctx, m.SpaceId); err != nil {
		return err
	}
	c.h.withDoc(m.SpaceId, m.DocId, func(ds *docState) {
		if len(ds.subs) == 0 {
			return
		}
		b, _ := proto.Marshal(&pb.ServerFrame{Msg: &pb.ServerFrame_Awareness{Awareness: &pb.AwarenessOut{
			SpaceId: m.SpaceId, DocId: m.DocId, Epoch: m.Epoch, From: c.user.SignPk, DeviceId: c.deviceID, Payload: m.Payload,
		}}})
		for sub := range ds.subs {
			if sub != c {
				sub.sendRaw(b)
			}
		}
	})
	return nil
}
