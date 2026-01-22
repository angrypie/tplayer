import { ArrowLeft, Image, ImageOff } from "lucide-react";
import React from "react";
import { Link } from "wouter";
import { Nav as BaseNav } from "~/components/layout/Nav";
import { Button } from "~/components/ui/button";

export const Nav = ({ showCover, onToggleCover }) => (
	<BaseNav>
		<Button variant="outline" type="button" asChild>
			<Link href="/">
				<ArrowLeft className="h-4 w-4" />
				<span className="hidden sm:inline">Back to library</span>
			</Link>
		</Button>
		<div className="flex-1" />
		<Button
			variant="outline"
			type="button"
			onClick={onToggleCover}
			aria-pressed={showCover}
		>
			{showCover ? (
				<ImageOff className="h-4 w-4" />
			) : (
				<Image className="h-4 w-4" />
			)}
			<span className="hidden sm:inline">
				{showCover ? "Hide cover" : "Show cover"}
			</span>
		</Button>
	</BaseNav>
);
