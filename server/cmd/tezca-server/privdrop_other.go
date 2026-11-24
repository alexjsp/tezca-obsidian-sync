//go:build !unix

package main

func dropPrivileges(string) error { return nil }
